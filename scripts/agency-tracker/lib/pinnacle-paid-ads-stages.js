// scripts/agency-tracker/lib/pinnacle-paid-ads-stages.js
//
// Stage → P&L concept mapping for the Pinnacle "Paid Ads Pipeline".
// Spec: docs/superpowers/plans/2026-05-23-agency-ad-manager-phase-2-3.md (locked design)
//
// Stage IDs are fetched at sync time from `getPipelines(locationId)` and matched by
// stage NAME (since stage IDs may rotate). The map below is by name.

const APPOINTMENT_STAGES = new Set([
  'Clarity Call Scheduled',
  'Clarity Call Rescheduled',
]);

const NO_SHOW_STAGES = new Set([
  'Clarity Call Ghost',
  '20 Min Triage Missed Call',
]);

function classifyStage(stageName) {
  if (APPOINTMENT_STAGES.has(stageName)) return 'appointment';
  if (NO_SHOW_STAGES.has(stageName)) return 'no_show';
  return 'lead';
}

const PIPELINE_ID = '3j5yy4pUlTNZcE9fDEez'; // "Paid Ads Pipeline" in Pinnacle sub-account
const PINNACLE_LOCATION_ID = 'A00xnmFDwXGfD7sx0QB8';

module.exports = {
  APPOINTMENT_STAGES,
  NO_SHOW_STAGES,
  classifyStage,
  PIPELINE_ID,
  PINNACLE_LOCATION_ID,
};
