// scripts/agency-tracker/lib/meta-derive.js
//
// Single source of truth for the 16-metric formulas in the Agency Ad Manager spec.
// Used by meta-ad-sync.js (tracker, Node) AND ported to Deno for the Edge Function.
// Spec: docs/superpowers/specs/2026-05-23-agency-ad-manager-design.md §5
//
// `derive(raw)` takes raw Meta Insights numbers and returns the derived metrics.
// Every output may be null when its denominator is zero — never Infinity or NaN.

const LOW_SIGNAL_THRESHOLD = 5; // dollars

function safeDiv(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function n(x) { return Number(x || 0); }

function derive(raw) {
  const spend = n(raw.spend);
  const impressions = n(raw.impressions);
  const reach = n(raw.reach);
  const clicks = n(raw.clicks);
  const inlineLinkClicks = n(raw.inline_link_clicks);
  const uniqueLinkClicks = n(raw.unique_inline_link_clicks);
  const leads = n(raw.leads);
  const lpv = n(raw.landing_page_views);
  const v3s = n(raw.video_3s_views);
  const vThru = n(raw.video_thruplays);
  const vAvg = n(raw.video_avg_watch_seconds);

  const cpmRaw = safeDiv(spend, impressions);
  const ctrLinkRaw = safeDiv(inlineLinkClicks, impressions);
  const ctrAllRaw = safeDiv(clicks, impressions);
  const uniqueCtrRaw = safeDiv(uniqueLinkClicks, reach);
  const lpvToLeadRaw = safeDiv(leads, lpv);
  // Hook/hold/avg-watch: only meaningful for video ads.
  // Treat zero 3s-views as "no video signal" — render `—` per spec §5.
  const hookRaw = v3s > 0 ? safeDiv(v3s, impressions) : null;
  const holdRaw = safeDiv(vThru, v3s);

  return {
    cpm:             cpmRaw === null ? null : cpmRaw * 1000,
    cpc_link:        safeDiv(spend, inlineLinkClicks),
    cpc_unique_link: safeDiv(spend, uniqueLinkClicks),
    ctr_link:        ctrLinkRaw === null ? null : ctrLinkRaw * 100,
    ctr_all:         ctrAllRaw === null ? null : ctrAllRaw * 100,
    unique_ctr:      uniqueCtrRaw === null ? null : uniqueCtrRaw * 100,
    lpv_to_lead_pct: lpvToLeadRaw === null ? null : lpvToLeadRaw * 100,
    imp_to_lead:     leads > 0 ? Math.round(impressions / leads) : null,
    cpl:             safeDiv(spend, leads),
    cpa:             null, // Phase 2: spend / appointments_booked from pinnacle_pipeline_snapshot join
    hook_rate:       hookRaw === null ? null : hookRaw * 100,
    hold_rate:       holdRaw === null ? null : holdRaw * 100,
    avg_watch_time:  vAvg > 0 ? vAvg : null,
    low_signal:      spend < LOW_SIGNAL_THRESHOLD,
  };
}

module.exports = { derive, LOW_SIGNAL_THRESHOLD };
