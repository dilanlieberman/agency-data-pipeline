// scripts/agency-tracker/ghl-pinnacle-pipeline-sync.js
//
// Polls the Pinnacle sub-account's "Paid Ads Pipeline" every 5 minutes (via cron),
// upserts opportunities into the `pinnacle_pipeline_snapshot` Supabase table.
// Lovable subscribes via realtime.
//
// Spec: docs/superpowers/specs/2026-05-23-agency-ad-manager-design.md §6.2
// Plan: docs/superpowers/plans/2026-05-23-agency-ad-manager-phase-2-3.md (Task 2.2)

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { createGhlClient } = require('./lib/ghl-client');
const { PIPELINE_ID, PINNACLE_LOCATION_ID } = require('./lib/pinnacle-paid-ads-stages');

const TOKEN = process.env.GHL_PINNACLE_PRIVATE_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LAUNCH_DATE = process.env.PINNACLE_ADS_LAUNCH_DATE || '2026-05-01';

function buildSnapshotRow(opp, stageMap) {
  // GHL API returns `pipelineStageId` (not `stageId`). Accept both for safety.
  const stageId = opp.pipelineStageId || opp.stageId || null;
  return {
    opp_id: opp.id,
    name: opp.name || '',
    stage_id: stageId,
    stage_name: stageId ? (stageMap[stageId] || null) : null,
    pipeline_id: opp.pipelineId || PIPELINE_ID,
    source: opp.source || null,
    monetary_value: opp.monetaryValue ?? null,
    created_at: opp.createdAt || opp.dateAdded || null,
    last_activity_at: opp.lastStageChangeAt || opp.updatedAt || null,
    raw_json: opp,
    pulled_at: new Date().toISOString(),
  };
}

async function main() {
  if (!TOKEN) throw new Error('GHL_PINNACLE_PRIVATE_TOKEN missing from .env');
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');

  const t0 = Date.now();
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const ghl = createGhlClient(TOKEN);

  // Build stage_id → stage_name map for this pipeline
  const pipelines = await ghl.getPipelines(PINNACLE_LOCATION_ID);
  const pipeline = pipelines.find((p) => p.id === PIPELINE_ID);
  if (!pipeline) throw new Error(`Paid Ads Pipeline (${PIPELINE_ID}) not found in location ${PINNACLE_LOCATION_ID}`);
  const stageMap = Object.fromEntries((pipeline.stages || []).map((s) => [s.id, s.name]));

  // Fetch all opportunities in the pipeline
  const opps = await ghl.getOpportunities(PINNACLE_LOCATION_ID, PIPELINE_ID, {});

  // Apply attribution filter: created_at >= LAUNCH_DATE
  const launchDateMs = new Date(LAUNCH_DATE).getTime();
  const attributed = opps.filter((o) => {
    const created = new Date(o.createdAt || o.dateAdded || 0).getTime();
    return created >= launchDateMs;
  });

  const rows = attributed.map((opp) => buildSnapshotRow(opp, stageMap));

  // Upsert
  if (rows.length > 0) {
    const { error } = await supabase.from('pinnacle_pipeline_snapshot').upsert(rows, { onConflict: 'opp_id' });
    if (error) throw new Error(`pinnacle_pipeline_snapshot upsert: ${error.message}`);
  }

  // Prune: delete rows for opp_ids that disappeared from the pipeline.
  const seenIds = new Set(rows.map((r) => r.opp_id));
  const { data: existing } = await supabase.from('pinnacle_pipeline_snapshot').select('opp_id');
  const toDelete = (existing || []).map((r) => r.opp_id).filter((id) => !seenIds.has(id));
  if (toDelete.length > 0) {
    await supabase.from('pinnacle_pipeline_snapshot').delete().in('opp_id', toDelete);
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `ghl-pinnacle-pipeline-sync ✓ ${rows.length} kept | ${opps.length - rows.length} excluded (pre-launch) | ${toDelete.length} pruned | ${dt}s`,
  );
}

module.exports = { buildSnapshotRow, main };

if (require.main === module) {
  main().catch((e) => {
    console.error('ghl-pinnacle-pipeline-sync FAIL:', e.message);
    process.exit(1);
  });
}
