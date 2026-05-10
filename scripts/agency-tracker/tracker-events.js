// Detects breach + XP-grant events for the Pinnacle Performance Tracker.
// Writes rows to tracker_breach_event + tracker_xp_event. The LifeOS bot
// polls those tables (via its own systemd timer in /home/claude/lifeos/)
// and fires McConaughey voice notes / grants XP per its existing rules.
//
// Run: node scripts/agency-tracker/tracker-events.js [--dry] [--force]
// Cron: hourly. Idempotent via dedup keys (kind + date / kind + payload).
//
// Severity tiers (per spec):
//   soft     — 1 missed day. Light Telegram prompt.
//   hard     — 2 missed days. Stronger language.
//   lockdown — 3+ missed days. Full McConaughey + dashboard locks.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');

const IMPERATIVE_FIELDS = [
  // mirror lib/imperative.py — keep in sync.
  'apartment_fund_balance_usd',
  'thailand_fund_balance_usd',
  'new_retainers_signed_today',
  'meta_total_spend',
  'meta_total_leads',
  'meta_avg_cpl',
  'meta_avg_ctr',
  'setter_msgs_sent_total',
  'setter_replies_total',
  'setter_positive_replies_total',
  'setter_appts_booked_total',
  'calls_held_today',
  'closes_today',
  'mrr_signed_today_usd',
  'client_sentiment_map',
];

const FUND_MILESTONES = [1_000, 3_000, 5_000, 7_000];

function todayEdt() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function isUploaded(row) {
  if (!row) return false;
  return IMPERATIVE_FIELDS.every((f) => row[f] !== null && row[f] !== undefined);
}

async function emitBreach({ severity, kind, payload }) {
  console.log(`  breach.${severity}/${kind}: ${JSON.stringify(payload)}`);
  if (DRY) return;
  const { error } = await supabase.from('tracker_breach_event').insert({
    severity,
    kind,
    payload,
  });
  if (error) console.log(`  [insert-error] ${error.message}`);
}

async function emitXp({ kind, suggested_xp, payload }) {
  console.log(`  xp.${kind} (+${suggested_xp}): ${JSON.stringify(payload)}`);
  if (DRY) return;
  // Dedup: don't fire if same kind+payload already exists for today.
  const dedupKey = JSON.stringify(payload);
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data: existing } = await supabase
    .from('tracker_xp_event')
    .select('id, payload')
    .eq('kind', kind)
    .gte('occurred_at', since.toISOString());
  if (!FORCE && (existing || []).some((r) => JSON.stringify(r.payload) === dedupKey)) {
    console.log(`    (already fired today, skipping)`);
    return;
  }
  const { error } = await supabase
    .from('tracker_xp_event')
    .insert({ kind, suggested_xp, payload });
  if (error) console.log(`  [insert-error] ${error.message}`);
}

async function checkMissedUpload() {
  // Check the previous day's row (today's lock window doesn't close until 23:59 EDT).
  // Walks yesterday-backwards counting consecutive missed days.
  const today = todayEdt();
  const { data: rows } = await supabase
    .from('tracker_daily')
    .select('*')
    .lt('date', today)
    .order('date', { ascending: false })
    .limit(7);
  let missed = 0;
  const missedDates = [];
  for (const r of rows || []) {
    if (isUploaded(r)) break;
    missed++;
    missedDates.push(r.date);
  }
  if (missed === 0) return;
  const severity = missed >= 3 ? 'lockdown' : missed === 2 ? 'hard' : 'soft';
  await emitBreach({
    severity,
    kind: 'missed_upload',
    payload: { streak: missed, missed_dates: missedDates },
  });
}

async function checkMrrDrop() {
  const { data: rows } = await supabase
    .from('agency_daily')
    .select('total_retainer_mrr,date')
    .order('date', { ascending: false })
    .limit(8);
  if (!rows || rows.length < 7) return;
  const today = Number(rows[0].total_retainer_mrr || 0);
  const weekAgo = Number(rows[6].total_retainer_mrr || 0);
  if (weekAgo > 0 && today < weekAgo * 0.95) {
    await emitBreach({
      severity: 'hard',
      kind: 'mrr_drop',
      payload: {
        today_mrr: today,
        week_ago_mrr: weekAgo,
        delta: today - weekAgo,
        delta_pct: ((today - weekAgo) / weekAgo) * 100,
      },
    });
  }
}

async function checkRetainerSigned() {
  const today = todayEdt();
  const { data: row } = await supabase
    .from('tracker_daily')
    .select('new_retainers_signed_today,mrr_signed_today_usd')
    .eq('date', today)
    .limit(1)
    .single();
  const n = Number(row?.new_retainers_signed_today || 0);
  if (n > 0) {
    await emitXp({
      kind: 'retainer_signed',
      suggested_xp: 500 * n,
      payload: { count: n, date: today, mrr_signed_today: row?.mrr_signed_today_usd },
    });
  }
}

async function checkFundMilestones() {
  const today = todayEdt();
  const { data: row } = await supabase
    .from('tracker_daily')
    .select('apartment_fund_balance_usd,thailand_fund_balance_usd')
    .eq('date', today)
    .limit(1)
    .single();
  if (!row) return;

  // Yesterday's balance for crossing-detection.
  const { data: prevRows } = await supabase
    .from('tracker_daily')
    .select('apartment_fund_balance_usd,thailand_fund_balance_usd,date')
    .lt('date', today)
    .order('date', { ascending: false })
    .limit(1);
  const prev = prevRows?.[0] || {};

  for (const fund of ['apartment_fund_balance_usd', 'thailand_fund_balance_usd']) {
    const cur = Number(row[fund] || 0);
    const before = Number(prev[fund] || 0);
    for (const m of FUND_MILESTONES) {
      if (before < m && cur >= m) {
        await emitXp({
          kind: 'fund_milestone',
          suggested_xp: 100 * (FUND_MILESTONES.indexOf(m) + 1),
          payload: { fund, milestone_usd: m, current_balance: cur },
        });
      }
    }
  }
}

async function main() {
  console.log(`tracker-events ${DRY ? '[DRY]' : ''}`);
  await checkMissedUpload();
  await checkMrrDrop();
  await checkRetainerSigned();
  await checkFundMilestones();
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
