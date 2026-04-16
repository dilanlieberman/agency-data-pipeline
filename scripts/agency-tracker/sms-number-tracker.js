/**
 * SMS Number Tracker + Per-Account Performance
 *
 * 1. Counts total SMS sent per sub-account from upload logs → alerts at 3000
 * 2. Pulls pipeline stage counts per sub-account from GHL → conversion metrics
 *
 * Writes to Supabase: sms_number_tracker (SMS counts) + setter_performance (pipeline metrics)
 *
 * Usage: node scripts/agency-tracker/sms-number-tracker.js
 * Runs daily via cron.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { GHL_BASE, GHL_VERSION } = require('./lib/config');

const SMS_ALERT_THRESHOLD = 3000;
const LOGS_DIR = path.join(__dirname, '../../data/logs');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function loadTokens() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/sub-account-tokens.json'), 'utf8'));
}

// ── Part 1: SMS count from upload logs ────────────────────────────────────────

function countSmsFromLogs() {
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.startsWith('upload-')).sort();
  const counts = {}; // normalized account name → total SMS

  for (const f of files) {
    try {
      const log = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, f), 'utf8'));
      const account = (log.params?.account || 'unknown').toLowerCase().trim();
      const uploaded = log.summary?.uploaded || 0;
      const skipped = log.summary?.skipped || 0;
      counts[account] = (counts[account] || 0) + uploaded + skipped;
    } catch (e) { /* skip bad files */ }
  }

  return counts;
}

// ── Part 2: Pipeline metrics from GHL ─────────────────────────────────────────

// Normalize stage names across different pipeline formats
function classifyStage(stageName) {
  const s = stageName.toLowerCase();
  if (s.includes('sms sent') || s.includes('initial text') || s.includes('in queue') || s.includes('new lead')) return 'sms_sent';
  if (s.includes('positive reply') || s.includes('responsive') || s.includes('interested')) return 'positive_reply';
  if (s.includes('negative') || s.includes('not interested') || s.includes('lost')) return 'negative';
  if (s.includes('non pickup') || s.includes('call back') || s.includes('follow')) return 'follow_up';
  if (s.includes('booked') || s.includes('scheduled') || s.includes('call booked')) return 'booked';
  if (s.includes('attended') || s.includes('showed') || s.includes('show')) return 'showed';
  if (s.includes('no show') || s.includes('no-show')) return 'no_show';
  if (s.includes('closed') || s.includes('sale')) return 'closed';
  if (s.includes('negotiation') || s.includes('prospect')) return 'negotiation';
  return 'other';
}

async function getPipelineMetrics(token, locationId) {
  // Get pipelines
  const pipRes = await axios.get(`${GHL_BASE}/opportunities/pipelines`, {
    headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: 'application/json' },
    params: { locationId },
  });

  const pipelines = pipRes.data.pipelines || [];
  // Find the lead/SMS pipeline (not sales pipeline)
  const leadPipeline = pipelines.find(p =>
    p.name.toLowerCase().includes('lead') || p.name.toLowerCase().includes('sms')
  );

  if (!leadPipeline) return null;

  // Build stage map
  const stageMap = {};
  for (const stage of (leadPipeline.stages || [])) {
    stageMap[stage.id] = { name: stage.name, category: classifyStage(stage.name) };
  }

  // Get opportunities (capped at 50 pages)
  const allOpps = [];
  let startAfter;
  for (let i = 0; i < 50; i++) {
    const params = { location_id: locationId, pipeline_id: leadPipeline.id, limit: 20 };
    if (startAfter) params.startAfter = startAfter;

    const res = await axios.get(`${GHL_BASE}/opportunities/search`, {
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: 'application/json' },
      params,
    });

    const page = res.data.opportunities || [];
    if (page.length === 0) break;
    allOpps.push(...page);
    if (page.length < 20) break;
    startAfter = page[page.length - 1].id;
    await new Promise(r => setTimeout(r, 250));
  }

  // Count by category
  const metrics = { sms_sent: 0, positive_reply: 0, negative: 0, follow_up: 0, booked: 0, showed: 0, no_show: 0, closed: 0, other: 0 };

  for (const opp of allOpps) {
    const stageInfo = stageMap[opp.pipelineStageId];
    if (stageInfo) {
      metrics[stageInfo.category] = (metrics[stageInfo.category] || 0) + 1;
    }
  }

  // Compute rates
  const total = allOpps.length;
  const replyRate = total > 0 ? ((metrics.positive_reply / total) * 100).toFixed(1) : 0;
  const bookingRate = metrics.positive_reply > 0 ? ((metrics.booked / metrics.positive_reply) * 100).toFixed(1) : 0;
  const showRate = metrics.booked > 0 ? (((metrics.showed + metrics.closed) / metrics.booked) * 100).toFixed(1) : 0;
  const closeRate = metrics.booked > 0 ? ((metrics.closed / metrics.booked) * 100).toFixed(1) : 0;

  return {
    pipeline_name: leadPipeline.name,
    total_opportunities: total,
    ...metrics,
    reply_rate: parseFloat(replyRate),
    booking_rate: parseFloat(bookingRate),
    show_rate: parseFloat(showRate),
    close_rate: parseFloat(closeRate),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`[sms-tracker] starting at ${new Date().toISOString()}`);

  const tokens = loadTokens();
  const smsCounts = countSmsFromLogs();

  const trackAccounts = [
    'dilan sub acc 1', 'dilan sub acc 2',
    'coleton sub acc 1', 'coleton sub acc 2',
    'cesar sub acc 1', 'tony sub acc 2',
  ];

  // Part 1: SMS counts
  console.log('\n=== SMS PER SUB-ACCOUNT ===');
  for (const [account, count] of Object.entries(smsCounts).sort((a, b) => b[1] - a[1])) {
    const status = count >= SMS_ALERT_THRESHOLD ? 'REPLACE' : count >= SMS_ALERT_THRESHOLD * 0.9 ? 'WARNING' : 'ok';
    console.log(`  ${account}: ${count} SMS [${status}]`);

    await supabase.from('sms_number_tracker').upsert({
      phone_number: account, // using account name as key until we map actual numbers
      location_id: account,
      sub_account: account,
      total_sent: count,
      last_updated: today,
    }, { onConflict: 'phone_number,location_id' });

    if (count >= SMS_ALERT_THRESHOLD) {
      // Check if alert already exists for this account
      const { data: existing } = await supabase
        .from('alerts')
        .select('id')
        .eq('alert_type', 'sms_number_limit')
        .ilike('message', `%${account}%`)
        .eq('resolved', false);

      if (!existing || existing.length === 0) {
        await supabase.from('alerts').insert({
          alert_type: 'sms_number_limit',
          severity: 'critical',
          message: `${account}: ${count} SMS sent — REPLACE THIS NUMBER (limit: ${SMS_ALERT_THRESHOLD})`,
        });
        console.log(`  ALERT FIRED: ${account}`);
      }
    }
  }

  // Part 2: Pipeline metrics per sub-account
  console.log('\n=== PIPELINE METRICS ===');
  for (const [locationId, info] of Object.entries(tokens)) {
    if (!trackAccounts.includes(info.name)) continue;

    console.log(`\n  ${info.name}:`);
    try {
      const metrics = await getPipelineMetrics(info.token, locationId);
      if (!metrics) {
        console.log('    no lead pipeline found');
        continue;
      }

      console.log(`    pipeline: ${metrics.pipeline_name}`);
      console.log(`    total: ${metrics.total_opportunities} | replies: ${metrics.positive_reply} (${metrics.reply_rate}%) | booked: ${metrics.booked} (${metrics.booking_rate}%) | showed: ${metrics.showed} (${metrics.show_rate}%) | closed: ${metrics.closed}`);

      const { other, ...cleanMetrics } = metrics;
      const { error: perfErr } = await supabase.from('setter_performance').upsert({
        sub_account: info.name,
        location_id: locationId,
        date: today,
        ...cleanMetrics,
      }, { onConflict: 'sub_account,date' });
      if (perfErr) console.log('    supabase error:', perfErr.message);
    } catch (e) {
      console.log(`    error: ${e.message}`);
    }
  }

  console.log('\n[sms-tracker] done.');
}

run().catch(err => {
  console.error('[sms-tracker] fatal:', err.message);
  process.exit(1);
});
