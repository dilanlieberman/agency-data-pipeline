// scripts/agency-tracker/meta-ad-daily-sync.js
//
// Pulls per-ad per-day Meta Insights for the last 30 days using `time_increment=1`,
// upserts into `meta_ad_daily`. Powers the Spend Allocation section + alerts
// in the Agency Ad Manager page.
//
// One row per (ad_id, date_key). Re-pulling is idempotent (id = "<ad_id>:<YYYY-MM-DD>").
//
// Cron: hourly, overlapping with the main meta-ad-sync (different table, no conflict).

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = (process.env.META_API_VERSION || 'v21.0').trim();
const BASE = `https://graph.facebook.com/${API_VERSION}`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const LOOKBACK_DAYS = parseInt(process.env.DAILY_LOOKBACK_DAYS || '30', 10);

const LEAD_ACTION_TYPES = new Set([
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
  'onsite_conversion.lead',
]);

const sumActions = (actions, types) =>
  (actions || []).filter((a) => types.has(a.action_type)).reduce((s, a) => s + Number(a.value || 0), 0);

const maxAction = (actions, types) => {
  const map = new Map((actions || []).map((a) => [a.action_type, Number(a.value || 0)]));
  return [...types].reduce((m, t) => Math.max(m, map.get(t) || 0), 0);
};

async function graph(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', TOKEN);
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
      return json;
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function listActiveAccounts() {
  const { data } = await graph('/me/adaccounts', {
    fields: 'id,account_id,name,account_status,business{name}',
    limit: 100,
  });
  return (data || []).filter(
    (a) => a.account_status === 1 && !a.name.toLowerCase().includes('dry test'),
  );
}

async function pullDailyForAccount(account, sinceDate, untilDate) {
  // Note: drop the effective_status filter so paused-but-historically-spent ads still appear.
  const allRows = [];
  let next = null;
  let pageCount = 0;
  do {
    const { data, paging } = await graph(`/${account.id}/insights`, {
      level: 'ad',
      time_range: JSON.stringify({ since: sinceDate, until: untilDate }),
      time_increment: '1',
      fields:
        'ad_id,ad_name,campaign_name,adset_name,spend,impressions,reach,clicks,' +
        'inline_link_clicks,actions,date_start',
      limit: 500,
      after: next || undefined,
    });
    pageCount += 1;
    for (const r of data || []) allRows.push(r);
    next = paging?.cursors?.after && paging?.next ? paging.cursors.after : null;
    if (pageCount > 20) break;
  } while (next);
  return allRows;
}

function buildDailyRow(account, row) {
  const dateKey = row.date_start;
  const actions = row.actions || [];
  return {
    id: `${row.ad_id}:${dateKey}`,
    ad_id: row.ad_id,
    ad_name: row.ad_name || '',
    account_id: account.id,
    account_name: account.name,
    campaign_name: row.campaign_name || '',
    adset_name: row.adset_name || '',
    date_key: dateKey,
    spend: Number(row.spend || 0),
    impressions: Number(row.impressions || 0),
    reach: Number(row.reach || 0),
    clicks_total: Number(row.clicks || 0),
    inline_link_clicks: Number(row.inline_link_clicks || 0),
    leads: maxAction(actions, LEAD_ACTION_TYPES),
    landing_page_views:
      sumActions(actions, new Set(['landing_page_view'])) ||
      sumActions(actions, new Set(['omni_landing_page_view'])),
    pulled_at: new Date().toISOString(),
  };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  if (!TOKEN) throw new Error('META_ACCESS_TOKEN missing');
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');

  const t0 = Date.now();
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const until = new Date();
  const since = new Date(until.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const sinceStr = isoDate(since);
  const untilStr = isoDate(until);

  const accounts = await listActiveAccounts();
  let totalRows = 0;
  let failures = 0;

  for (const acct of accounts) {
    try {
      const raw = await pullDailyForAccount(acct, sinceStr, untilStr);
      const rows = raw.map((r) => buildDailyRow(acct, r));
      if (rows.length > 0) {
        // Chunk upserts to keep payload sizes manageable.
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const { error } = await supabase
            .from('meta_ad_daily')
            .upsert(rows.slice(i, i + CHUNK), { onConflict: 'id' });
          if (error) throw new Error(`upsert: ${error.message}`);
        }
        totalRows += rows.length;
      }
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${acct.name}: ${e.message}`);
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `meta-ad-daily-sync ✓ ${totalRows} rows | ${accounts.length} accts (${failures} fail) | window ${sinceStr}..${untilStr} | ${dt}s`,
  );
}

module.exports = { buildDailyRow, main };

if (require.main === module) {
  main().catch((e) => {
    console.error('meta-ad-daily-sync FAIL:', e.message);
    process.exit(1);
  });
}
