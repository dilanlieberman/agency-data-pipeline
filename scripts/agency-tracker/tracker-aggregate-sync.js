// Aggregate meta_ad_snapshot + conversation_metrics_daily into today's
// tracker_daily row. Runs hourly via cron — keeps Layer 2 + Layer 3 fields
// in tracker_daily fresh so the imperative-field lock-rule has a single
// source of truth.
//
// Run: node scripts/agency-tracker/tracker-aggregate-sync.js [--dry] [--date YYYY-MM-DD]

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const TARGET_DATE = (() => {
  const i = args.indexOf('--date');
  return i >= 0 ? args[i + 1] : null;
})();

function todayEdt() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function aggregateMeta(date) {
  // meta_ad_snapshot rows for the active 'last_7d' preset, latest pulled_at per ad.
  // Aggregate to today's spend / leads / CPL / CTR per client + total.
  const { data, error } = await supabase
    .from('meta_ad_snapshot')
    .select('*')
    .eq('date_preset', 'last_7d');
  if (error) throw new Error(`meta_ad_snapshot: ${error.message}`);

  const perClient = new Map();
  let totalSpend = 0;
  let totalLeads = 0;
  let totalImpressions = 0;
  let totalClicks = 0;

  for (const row of data || []) {
    const client = row.account_name || row.client_name || 'unknown';
    if (!perClient.has(client)) {
      perClient.set(client, {
        spend: 0,
        leads: 0,
        impressions: 0,
        clicks: 0,
        cpl: null,
        ctr: null,
        cpm: null,
        freq: row.frequency != null ? Number(row.frequency) : null,
      });
    }
    const c = perClient.get(client);
    c.spend += Number(row.spend || 0);
    c.leads += Number(row.leads || 0);
    c.impressions += Number(row.impressions || 0);
    c.clicks += Number(row.link_clicks || row.clicks || 0);
    totalSpend += Number(row.spend || 0);
    totalLeads += Number(row.leads || 0);
    totalImpressions += Number(row.impressions || 0);
    totalClicks += Number(row.link_clicks || row.clicks || 0);
  }

  // Compute derived rates per client.
  const perClientObj = {};
  for (const [client, c] of perClient.entries()) {
    if (c.leads > 0) c.cpl = +(c.spend / c.leads).toFixed(2);
    if (c.impressions > 0) {
      c.ctr = +((c.clicks / c.impressions) * 100).toFixed(2);
      c.cpm = +((c.spend / c.impressions) * 1000).toFixed(2);
    }
    perClientObj[client] = c;
  }

  return {
    meta_total_spend: +totalSpend.toFixed(2),
    meta_total_leads: totalLeads,
    meta_avg_cpl: totalLeads > 0 ? +(totalSpend / totalLeads).toFixed(2) : null,
    meta_avg_ctr: totalImpressions > 0 ? +((totalClicks / totalImpressions) * 100).toFixed(2) : null,
    meta_per_client: perClientObj,
  };
}

async function aggregateSetters(date) {
  const { data, error } = await supabase
    .from('conversation_metrics_daily')
    .select('*')
    .eq('date', date);
  if (error) throw new Error(`conversation_metrics_daily: ${error.message}`);

  const perSetter = new Map();
  let sentTotal = 0;
  let repliesTotal = 0;
  let posTotal = 0;
  let booked = 0;

  for (const row of data || []) {
    const s = row.setter_name;
    if (!perSetter.has(s)) {
      perSetter.set(s, {
        msgs_sent: 0,
        msgs_received: 0,
        unique_contacts: 0,
        replies_received: 0,
        positive_replies: 0,
        appts_booked: 0,
        median_response_minutes: row.median_response_minutes,
      });
    }
    const c = perSetter.get(s);
    c.msgs_sent += Number(row.msgs_sent || 0);
    c.msgs_received += Number(row.msgs_received || 0);
    c.unique_contacts += Number(row.unique_contacts_messaged || 0);
    c.replies_received += Number(row.replies_received || 0);
    c.positive_replies += Number(row.positive_replies || 0);
    c.appts_booked += Number(row.appts_booked || 0);

    sentTotal += Number(row.msgs_sent || 0);
    repliesTotal += Number(row.replies_received || 0);
    posTotal += Number(row.positive_replies || 0);
    booked += Number(row.appts_booked || 0);
  }

  // Booked appointments — fall back to setter_daily.calls_booked if conv-sync
  // didn't capture appts (calendar API still 422s without a calendarId).
  if (booked === 0) {
    const { data: sd } = await supabase
      .from('setter_daily')
      .select('setter_name, calls_booked')
      .eq('date', date);
    for (const row of sd || []) {
      booked += Number(row.calls_booked || 0);
      const s = perSetter.get(row.setter_name);
      if (s) s.appts_booked = Number(row.calls_booked || 0);
    }
  }

  const perSetterObj = {};
  for (const [k, v] of perSetter.entries()) perSetterObj[k] = v;

  return {
    setter_msgs_sent_total: sentTotal,
    setter_replies_total: repliesTotal,
    setter_positive_replies_total: posTotal,
    setter_appts_booked_total: booked,
    setter_per_setter: perSetterObj,
  };
}

async function main() {
  const date = TARGET_DATE || todayEdt();
  console.log(`tracker-aggregate-sync ${date} ${DRY ? '[DRY]' : ''}`);

  const meta = await aggregateMeta(date);
  console.log(
    `  meta: spend=$${meta.meta_total_spend} leads=${meta.meta_total_leads} cpl=${meta.meta_avg_cpl} ctr=${meta.meta_avg_ctr}% clients=${Object.keys(meta.meta_per_client).length}`
  );

  const setters = await aggregateSetters(date);
  console.log(
    `  setters: sent=${setters.setter_msgs_sent_total} replies=${setters.setter_replies_total} pos=${setters.setter_positive_replies_total} booked=${setters.setter_appts_booked_total}`
  );

  const update = {
    date,
    ...meta,
    ...setters,
    last_auto_pull_at: new Date().toISOString(),
  };

  if (!DRY) {
    const { error } = await supabase.from('tracker_daily').upsert(update, { onConflict: 'date' });
    if (error) console.log(`  [supabase-upsert-error] ${error.message}`);
    else console.log('  upserted tracker_daily.');
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
