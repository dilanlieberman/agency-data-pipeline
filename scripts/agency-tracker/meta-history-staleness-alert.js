#!/usr/bin/env node
// meta-history-staleness-alert.js
//
// Pings Discord if `meta_ad_history` hasn't been refreshed in > STALE_HOURS.
// Catches silent failures of the Meta feeder (meta-ad-history-sync.js) like the
// 2026-05-31..06-04 outage that froze client dashboard spend for ~5 days.
//
// Cron (VPS): hourly. Run with `--test` to send a one-off delivery test.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const STALE_HOURS = Number(process.env.META_HISTORY_STALE_HOURS || 24);
const { DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID } = process.env;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function postToDiscord(content) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID) {
    throw new Error('DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID not set');
  }
  const res = await fetch(
    `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok) {
    throw new Error(`discord http ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

async function main() {
  if (process.argv.includes('--test')) {
    await postToDiscord('✅ Test: Revenue Engine spend-staleness alert is wired up and can reach this channel.');
    console.log('test alert sent');
    return;
  }

  const { data, error } = await supabase
    .from('meta_ad_history')
    .select('pulled_at')
    .order('pulled_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`supabase: ${error.message}`);

  const last = data && data[0] && data[0].pulled_at ? new Date(data[0].pulled_at) : null;
  if (!last) {
    await postToDiscord('🚨 Revenue Engine: `meta_ad_history` has NO rows — the Meta feeder is broken.');
    console.log('ALERT sent: no rows');
    return;
  }

  const hours = (Date.now() - last.getTime()) / 3600000;
  const stamp = last.toISOString().replace('T', ' ').slice(0, 16);
  if (hours > STALE_HOURS) {
    await postToDiscord(
      `🚨 **Revenue Engine spend stale** — \`meta_ad_history\` last refreshed ${hours.toFixed(1)}h ago ` +
      `(${stamp} UTC, threshold ${STALE_HOURS}h). The Meta feeder (meta-ad-history-sync) on the VPS is ` +
      `likely failing, so client dashboards are showing frozen ad spend. ` +
      `Check /var/log/meta-ad-history-sync.log`,
    );
    console.log(`ALERT sent: ${hours.toFixed(1)}h stale`);
  } else {
    console.log(`OK: meta_ad_history ${hours.toFixed(1)}h fresh (threshold ${STALE_HOURS}h)`);
  }
}

main().catch((e) => {
  console.error('staleness-alert error:', e.message);
  process.exit(1);
});
