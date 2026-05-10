// Compute per-client + per-setter baselines from the trailing 30-day window.
// Writes a versioned snapshot to tracker_baselines (one row per snapshot_date).
// Cron: Sundays 23:00 EDT (see pinnacle-tracker/OPS.md).
//
// Methodology — see DECISIONS.md #5 / #6:
//   - 30-day window, weighted by spend (paid ads) / volume (setters)
//   - "aim for" = baseline × 1.10 (lower-is-better metrics: × 0.85)
//   - "red flag"  = baseline × 0.80 (lower-is-better metrics: × 1.25)
//
// Run: node scripts/agency-tracker/compute-baselines.js [--dry] [--window 30]

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const WINDOW_DAYS = (() => {
  const i = args.indexOf('--window');
  return i >= 0 ? parseInt(args[i + 1], 10) : 30;
})();

function todayEdt() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function cutoffEdt() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - WINDOW_DAYS);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function weightedMean(values, weights) {
  let totalW = 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null || weights[i] == null) continue;
    sum += values[i] * weights[i];
    totalW += weights[i];
  }
  return totalW > 0 ? sum / totalW : null;
}

async function computeClientBaselines() {
  const cutoff = cutoffEdt();
  const { data, error } = await supabase
    .from('meta_ad_snapshot')
    .select('*')
    .eq('date_preset', 'last_7d')
    .gte('pulled_at', `${cutoff}T00:00:00Z`);
  if (error) throw new Error(`meta_ad_snapshot: ${error.message}`);

  const perClient = new Map();
  for (const row of data || []) {
    const client = row.account_name || row.client_name || 'unknown';
    if (!perClient.has(client)) {
      perClient.set(client, {
        spend: [],
        leads: [],
        impressions: [],
        clicks: [],
        cpl: [],
        ctr: [],
        cpm: [],
        freq: [],
      });
    }
    const c = perClient.get(client);
    c.spend.push(Number(row.spend || 0));
    c.leads.push(Number(row.leads || 0));
    c.impressions.push(Number(row.impressions || 0));
    c.clicks.push(Number(row.link_clicks || row.clicks || 0));
    c.cpl.push(Number(row.cpl || 0) || null);
    c.ctr.push(Number(row.ctr || 0) || null);
    c.cpm.push(Number(row.cpm || 0) || null);
    c.freq.push(Number(row.frequency || 0) || null);
  }

  const out = {};
  for (const [client, c] of perClient.entries()) {
    const totalSpend = c.spend.reduce((a, b) => a + b, 0);
    const totalLeads = c.leads.reduce((a, b) => a + b, 0);
    const totalImps = c.impressions.reduce((a, b) => a + b, 0);
    const totalClicks = c.clicks.reduce((a, b) => a + b, 0);
    out[client] = {
      sample_size: c.spend.length,
      total_spend: +totalSpend.toFixed(2),
      total_leads: totalLeads,
      cpl: totalLeads > 0 ? +(totalSpend / totalLeads).toFixed(2) : null,
      ctr: totalImps > 0 ? +((totalClicks / totalImps) * 100).toFixed(2) : null,
      cpm: totalImps > 0 ? +((totalSpend / totalImps) * 1000).toFixed(2) : null,
      freq: weightedMean(c.freq, c.spend) ?? null,
    };
  }
  return out;
}

async function computeSetterBaselines() {
  const cutoff = cutoffEdt();
  const { data, error } = await supabase
    .from('conversation_metrics_daily')
    .select('*')
    .gte('date', cutoff);
  if (error) throw new Error(`conversation_metrics_daily: ${error.message}`);

  const perSetter = new Map();
  for (const row of data || []) {
    const s = row.setter_name;
    if (!perSetter.has(s)) {
      perSetter.set(s, { sent: 0, replies: 0, pos: 0, booked: 0, response_minutes: [] });
    }
    const c = perSetter.get(s);
    c.sent += Number(row.msgs_sent || 0);
    c.replies += Number(row.replies_received || 0);
    c.pos += Number(row.positive_replies || 0);
    c.booked += Number(row.appts_booked || 0);
    if (row.median_response_minutes != null) c.response_minutes.push(Number(row.median_response_minutes));
  }

  const out = {};
  for (const [s, c] of perSetter.entries()) {
    out[s] = {
      sample_size: c.response_minutes.length,
      msgs_sent_total: c.sent,
      reply_rate_pct: c.sent > 0 ? +((c.replies / c.sent) * 100).toFixed(2) : null,
      positive_reply_rate_pct: c.sent > 0 ? +((c.pos / c.sent) * 100).toFixed(2) : null,
      booking_rate_pct: c.pos > 0 ? +((c.booked / c.pos) * 100).toFixed(2) : null,
      median_response_minutes:
        c.response_minutes.length > 0
          ? c.response_minutes.sort((a, b) => a - b)[Math.floor(c.response_minutes.length / 2)]
          : null,
    };
  }
  return out;
}

async function main() {
  const snapshot_date = todayEdt();
  console.log(`compute-baselines window=${WINDOW_DAYS}d snapshot_date=${snapshot_date} ${DRY ? '[DRY]' : ''}`);

  const [perClient, perSetter] = await Promise.all([computeClientBaselines(), computeSetterBaselines()]);

  console.log(`  per_client clients: ${Object.keys(perClient).length}`);
  console.log(`  per_setter setters: ${Object.keys(perSetter).length}`);

  const row = {
    snapshot_date,
    window_days: WINDOW_DAYS,
    per_client: perClient,
    per_setter: perSetter,
    methodology:
      'Weighted-mean baselines over trailing window. Aim-for = ×1.10 (rate-style) or ×0.85 (cost-style). Red-flag = ×0.80 / ×1.25.',
  };

  if (!DRY) {
    const { error } = await supabase
      .from('tracker_baselines')
      .upsert(row, { onConflict: 'snapshot_date' });
    if (error) console.log(`  [supabase-upsert-error] ${error.message}`);
    else console.log('  upserted tracker_baselines.');
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
