#!/usr/bin/env node
// meta-ad-history-backfill.js
//
// Pulls ALL ads (any status) for every ad account under the Business Manager,
// extracts creative/copy, pulls full lifetime daily insights (date_preset=maximum,
// time_increment=1), computes derived metrics, aggregates per-ad summaries,
// detects ad swaps, and upserts into 3 Supabase tables:
//   - meta_ad_history         (daily rows)
//   - meta_ad_history_summary (per-ad lifetime)
//   - meta_ad_history_swaps   (detected transitions)

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const {
  graph,
  stripClient,
  sumActions,
  maxAction,
  LEAD_ACTION_TYPES,
  listAllAccounts,
} = require('./lib/meta-helpers');

const { derive } = require('./lib/meta-derive');
const { matchConcept } = require('./lib/ad-copy-variants');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─────────────────────────────────────────────────────────────────────────────
// Pure functions (exported for testing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MAX across matching action types for a given per-window action sub-field.
 * Mirrors the maxAction pattern (avoids double-counting lead types).
 */
function getActionWindowValue(actions, types, windowField) {
  const arr = actions || [];
  let max = 0;
  for (const a of arr) {
    if (!types.has(a.action_type)) continue;
    const v = Number(a[windowField] || 0);
    if (v > max) max = v;
  }
  return max;
}

/**
 * SUM across matching action types for a given per-window action sub-field.
 * Mirrors the sumActions pattern (used for LPV with omni fallback).
 */
function getActionWindowSum(actions, types, windowField) {
  return (actions || [])
    .filter((a) => types.has(a.action_type))
    .reduce((s, a) => s + Number(a[windowField] || 0), 0);
}

/**
 * Build a daily row for the meta_ad_history table from a Meta Insights API row.
 * @param {Object} account - Account object with id, name, business
 * @param {Object} raw - Raw Meta Insights API row (single day, time_increment=1)
 * @returns {Object} Row ready for Supabase upsert
 */
function buildDailyRow(account, raw) {
  const spend = Number(raw.spend || 0);
  const impressions = Number(raw.impressions || 0);
  const reach = Number(raw.reach || 0);
  const clicksTotal = Number(raw.clicks || 0);
  const inlineLinkClicks = Number(raw.inline_link_clicks || 0);
  const uniqueInlineLinkClicks = Number(raw.unique_inline_link_clicks || 0);

  const actions = raw.actions || [];

  // Leads: MAX across lead action types (not sum — avoids double-counting).
  const leads = maxAction(actions, LEAD_ACTION_TYPES);

  // LPV: prefer landing_page_view, fall back to omni_landing_page_view.
  const lpv =
    sumActions(actions, new Set(['landing_page_view'])) ||
    sumActions(actions, new Set(['omni_landing_page_view']));

  // Video metrics from dedicated action arrays.
  const v3sViews = sumActions(actions, new Set(['video_view']));
  const vThruplays = sumActions(
    raw.video_thruplay_watched_actions || [],
    new Set(['video_view'])
  );
  const vAvgWatchRaw = (raw.video_avg_time_watched_actions || []).find(
    (a) => a.action_type === 'video_view'
  )?.value;
  const vAvgWatchSeconds = vAvgWatchRaw != null ? Number(vAvgWatchRaw) : 0;

  // Video retention percentile actions.
  const videoP25 = sumActions(raw.video_p25_watched_actions || [], new Set(['video_view']));
  const videoP50 = sumActions(raw.video_p50_watched_actions || [], new Set(['video_view']));
  const videoP75 = sumActions(raw.video_p75_watched_actions || [], new Set(['video_view']));
  const videoP95 = sumActions(raw.video_p95_watched_actions || [], new Set(['video_view']));

  // ── Per-attribution-window leads & LPV ─────────────────────────────────────
  // Requires action_attribution_windows=['1d_click','7d_click','1d_view'] on the
  // Insights call so Meta returns per-window sub-fields on each action object.
  // Note: 7d_click is a superset of 1d_click. 1d_view is separate from clicks.
  // Default = 7dc1dv = 7d_click + 1d_view (the standard for new offers).
  const LPV_TYPES_PRIMARY = new Set(['landing_page_view']);
  const LPV_TYPES_FALLBACK = new Set(['omni_landing_page_view']);
  const LEAD_TYPES_SET = new Set(LEAD_ACTION_TYPES);

  const leads_7dc = getActionWindowValue(actions, LEAD_TYPES_SET, '7d_click');
  const leads_1dc = getActionWindowValue(actions, LEAD_TYPES_SET, '1d_click');
  const leads_view = getActionWindowValue(actions, LEAD_TYPES_SET, '1d_view');
  // leads_default = 7dc1dv = 7d_click + 1d_view (the standard for new offers).
  const leads_default = leads_7dc + leads_view;

  const lpv_7dc =
    getActionWindowSum(actions, LPV_TYPES_PRIMARY, '7d_click') ||
    getActionWindowSum(actions, LPV_TYPES_FALLBACK, '7d_click');
  const lpv_1dc =
    getActionWindowSum(actions, LPV_TYPES_PRIMARY, '1d_click') ||
    getActionWindowSum(actions, LPV_TYPES_FALLBACK, '1d_click');
  const lpv_view =
    getActionWindowSum(actions, LPV_TYPES_PRIMARY, '1d_view') ||
    getActionWindowSum(actions, LPV_TYPES_FALLBACK, '1d_view');
  const lpv_default = lpv_7dc + lpv_view;

  // Derive all computed metrics via the canonical formula set.
  const derived = derive({
    spend,
    impressions,
    reach,
    clicks: clicksTotal,
    inline_link_clicks: inlineLinkClicks,
    unique_inline_link_clicks: uniqueInlineLinkClicks,
    leads,
    landing_page_views: lpv,
    video_3s_views: v3sViews,
    video_thruplays: vThruplays,
    video_avg_watch_seconds: vAvgWatchSeconds,
  });

  const round2 = (n) => (n === null ? null : +n.toFixed(2));

  return {
    id: `${raw.ad_id}:${raw.date_start}`,
    ad_id: raw.ad_id,
    ad_name: raw.ad_name || '',
    campaign_name: raw.campaign_name || '',
    adset_name: raw.adset_name || '',
    account_id: account.id,
    client_display: stripClient(account.name),
    date_key: raw.date_start,
    spend: +spend.toFixed(2),
    impressions,
    reach,
    clicks_total: clicksTotal,
    inline_link_clicks: inlineLinkClicks,
    unique_inline_link_clicks: uniqueInlineLinkClicks,
    leads,
    landing_page_views: lpv,
    video_3s_views: v3sViews,
    video_thruplays: vThruplays,
    video_avg_watch_seconds: vAvgWatchSeconds > 0 ? vAvgWatchSeconds : null,
    frequency: Number(raw.frequency || 0) || null,
    hook_rate: round2(derived.hook_rate),
    hold_rate: round2(derived.hold_rate),
    ctr_link: round2(derived.ctr_link),
    ctr_all: round2(derived.ctr_all),
    unique_ctr: round2(derived.unique_ctr),
    cpl: round2(derived.cpl),
    cpc_link: round2(derived.cpc_link),
    cpc_unique_link: round2(derived.cpc_unique_link),
    cpm: round2(derived.cpm),
    lpv_to_lead_pct: round2(derived.lpv_to_lead_pct),
    avg_watch_time: round2(derived.avg_watch_time),
    imp_to_lead: derived.imp_to_lead,
    low_signal: derived.low_signal,
    // Quality / relevance rankings (strings from Meta, e.g. "ABOVE_AVERAGE_35").
    quality_ranking: raw.quality_ranking || null,
    engagement_rate_ranking: raw.engagement_rate_ranking || null,
    conversion_rate_ranking: raw.conversion_rate_ranking || null,
    // Video retention percentiles.
    video_p25_watched: videoP25,
    video_p50_watched: videoP50,
    video_p75_watched: videoP75,
    video_p95_watched: videoP95,
    // Attribution window columns (real per-window values from Meta).
    // leads/landing_page_views above use account default attribution; these
    // diagnose how much depends on view-through vs click attribution.
    leads_7dc,
    leads_1dc,
    leads_default,
    lpv_7dc,
    lpv_1dc,
    lpv_default,
    pulled_at: new Date().toISOString(),
  };
}

/**
 * Extract creative metadata from a Meta Ad API response object.
 * @param {Object} ad - Meta Ad object (from /{ad_id} with creative fields)
 * @param {Object} account - Account object
 * @returns {Object} Creative metadata for summary row
 */
function extractCreative(ad, account) {
  const creative = ad.creative || {};
  const oss = creative.object_story_spec || {};
  const videoData = oss.video_data || null;
  const linkData = oss.link_data || null;
  const story = videoData || linkData || {};

  const primaryText = story.message || null;
  const headline = story.name || story.title || null;
  const description = story.description || null;
  const callToAction = story.call_to_action?.type || null;

  // Creative type detection.
  let creativeType = 'image';
  if (creative.video_id) {
    creativeType = 'video';
  } else if (linkData?.child_attachments && linkData.child_attachments.length > 1) {
    creativeType = 'carousel';
  }

  return {
    primary_text: primaryText,
    headline,
    description,
    call_to_action: callToAction,
    creative_type: creativeType,
    creative_id: creative.id || null,
    creative_thumbnail_url: creative.thumbnail_url || null,
    creative_video_id: creative.video_id || null,
    creative_video_url: null, // lazy-loaded later
    ad_created_time: ad.created_time || null,
    effective_status: ad.effective_status || null,
  };
}

/**
 * Compute lifetime summary from an array of daily rows for one ad.
 * @param {Array} dailyRows - Daily rows (same ad_id)
 * @param {Object} creative - Creative metadata object from extractCreative
 * @returns {Object} Row for meta_ad_history_summary
 */
function computeSummary(dailyRows, creative) {
  if (!dailyRows.length) return null;

  const first = dailyRows[0];

  const totalSpend = dailyRows.reduce((s, r) => s + Number(r.spend || 0), 0);
  const totalImpressions = dailyRows.reduce((s, r) => s + Number(r.impressions || 0), 0);
  const totalLeads = dailyRows.reduce((s, r) => s + Number(r.leads || 0), 0);
  const totalLpv = dailyRows.reduce((s, r) => s + Number(r.landing_page_views || 0), 0);
  const totalLinkClicks = dailyRows.reduce((s, r) => s + Number(r.inline_link_clicks || 0), 0);
  const totalV3s = dailyRows.reduce((s, r) => s + Number(r.video_3s_views || 0), 0);
  const totalThruplays = dailyRows.reduce((s, r) => s + Number(r.video_thruplays || 0), 0);

  // Video retention percentiles.
  const totalVideoP25 = dailyRows.reduce((s, r) => s + Number(r.video_p25_watched || 0), 0);
  const totalVideoP50 = dailyRows.reduce((s, r) => s + Number(r.video_p50_watched || 0), 0);
  const totalVideoP75 = dailyRows.reduce((s, r) => s + Number(r.video_p75_watched || 0), 0);
  const totalVideoP95 = dailyRows.reduce((s, r) => s + Number(r.video_p95_watched || 0), 0);

  // Attribution window totals — aggregate per-window counts across daily rows.
  const totalLeads7dc = dailyRows.reduce((s, r) => s + Number(r.leads_7dc || 0), 0);
  const totalLeads1dc = dailyRows.reduce((s, r) => s + Number(r.leads_1dc || 0), 0);
  const totalLeadsDefault = dailyRows.reduce((s, r) => s + Number(r.leads_default || 0), 0);
  const totalLpv7dc = dailyRows.reduce((s, r) => s + Number(r.lpv_7dc || 0), 0);
  const totalLpv1dc = dailyRows.reduce((s, r) => s + Number(r.lpv_1dc || 0), 0);
  const totalLpvDefault = dailyRows.reduce((s, r) => s + Number(r.lpv_default || 0), 0);

  // Attribution gap: % of default-window leads that are view-through
  // (i.e. in 7dc1dv but not in 7d_click alone). High % = leads vanish if
  // Meta tightens attribution; the "attribution silent killer" diagnostic.
  const attributionGapPct =
    totalLeadsDefault > 0
      ? +(((totalLeadsDefault - totalLeads7dc) / totalLeadsDefault) * 100).toFixed(2)
      : null;

  // Quality/relevance ranking mode (most common non-null value).
  const mode = (arr) => {
    const filtered = arr.filter((v) => v != null);
    if (!filtered.length) return null;
    const counts = {};
    for (const v of filtered) counts[v] = (counts[v] || 0) + 1;
    let best = null;
    let bestCount = 0;
    for (const [val, count] of Object.entries(counts)) {
      if (count > bestCount) { best = val; bestCount = count; }
    }
    return best;
  };

  const avgQualityRanking = mode(dailyRows.map((r) => r.quality_ranking));
  const avgEngagementRateRanking = mode(dailyRows.map((r) => r.engagement_rate_ranking));
  const avgConversionRateRanking = mode(dailyRows.map((r) => r.conversion_rate_ranking));

  const safeDiv = (num, den) => (den > 0 ? num / den : null);
  const safePct = (num, den) => {
    const r = safeDiv(num, den);
    return r !== null ? r * 100 : null;
  };

  // Active days: count of days with spend > 0.
  const spendDays = dailyRows.filter((r) => Number(r.spend || 0) > 0);
  const activeDays = spendDays.length;

  // First/last spend date: MIN/MAX date_key where spend > 0.
  let firstSpendDate = null;
  let lastSpendDate = null;
  if (spendDays.length > 0) {
    const sortedDates = spendDays.map((r) => r.date_key).sort();
    firstSpendDate = sortedDates[0];
    lastSpendDate = sortedDates[sortedDates.length - 1];
  }

  return {
    ad_id: first.ad_id,
    ad_name: first.ad_name,
    campaign_name: first.campaign_name,
    adset_name: first.adset_name,
    account_id: first.account_id,
    client_display: first.client_display,
    total_spend: totalSpend,
    total_impressions: totalImpressions,
    total_leads: totalLeads,
    total_lpv: totalLpv,
    total_link_clicks: totalLinkClicks,
    lifetime_cpl: safeDiv(totalSpend, totalLeads),
    lifetime_ctr_link: safePct(totalLinkClicks, totalImpressions),
    lifetime_hook_rate: totalV3s > 0 ? safePct(totalV3s, totalImpressions) : null,
    lifetime_hold_rate: totalV3s > 0 ? safePct(totalThruplays, totalV3s) : null,
    lifetime_lpv_to_lead_pct: safePct(totalLeads, totalLpv),
    active_days: activeDays,
    first_spend_date: firstSpendDate,
    last_spend_date: lastSpendDate,
    // Video retention percentiles.
    total_video_p25: totalVideoP25,
    total_video_p50: totalVideoP50,
    total_video_p75: totalVideoP75,
    total_video_p95: totalVideoP95,
    video_retention_25: totalImpressions > 0 ? (totalVideoP25 / totalImpressions) * 100 : null,
    video_retention_50: totalImpressions > 0 ? (totalVideoP50 / totalImpressions) * 100 : null,
    video_retention_75: totalImpressions > 0 ? (totalVideoP75 / totalImpressions) * 100 : null,
    video_retention_95: totalImpressions > 0 ? (totalVideoP95 / totalImpressions) * 100 : null,
    // Quality/relevance ranking modes.
    avg_quality_ranking: avgQualityRanking,
    avg_engagement_rate_ranking: avgEngagementRateRanking,
    avg_conversion_rate_ranking: avgConversionRateRanking,
    // Attribution window totals — real per-window aggregates.
    total_leads_7dc: totalLeads7dc,
    total_leads_1dc: totalLeads1dc,
    total_leads_default: totalLeadsDefault,
    total_lpv_7dc: totalLpv7dc,
    total_lpv_1dc: totalLpv1dc,
    total_lpv_default: totalLpvDefault,
    attribution_gap_pct: attributionGapPct,
    // Creative pass-through from extractCreative result.
    ad_created_time: creative.ad_created_time || null,
    effective_status: creative.effective_status || null,
    primary_text: creative.primary_text || null,
    headline: creative.headline || null,
    description: creative.description || null,
    call_to_action: creative.call_to_action || null,
    ad_copy_concept: matchConcept(first.ad_name),
    creative_id: creative.creative_id || null,
    creative_type: creative.creative_type || null,
    creative_thumbnail_url: creative.creative_thumbnail_url || null,
    creative_video_id: creative.creative_video_id || null,
    creative_video_url: creative.creative_video_url || null,
    pulled_at: new Date().toISOString(),
  };
}

/**
 * Detect ad swaps within campaigns.
 * Groups by (account_id, campaign_name), sorts by first_spend_date, and
 * checks for transitions where one ad stopped and another started nearby.
 *
 * @param {Array} summaries - Array of summary objects
 * @param {Object} dailyByAd - Map of ad_id → array of daily rows
 * @returns {Array} Swap objects for meta_ad_history_swaps
 */
function detectSwaps(summaries, dailyByAd) {
  const swaps = [];

  // Group by (account_id, campaign_name).
  const groups = new Map();
  for (const s of summaries) {
    if (!s.first_spend_date) continue; // skip ads that never spent
    const key = `${s.account_id}::${s.campaign_name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    // Sort by first_spend_date ascending.
    group.sort((a, b) => a.first_spend_date.localeCompare(b.first_spend_date));

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const oldAd = group[i];
        const newAd = group[j];

        // Check if old's last_spend_date is within 5 days of new's first_spend_date.
        const oldLast = new Date(oldAd.last_spend_date);
        const newFirst = new Date(newAd.first_spend_date);
        const gapMs = newFirst - oldLast;
        const gapDays = Math.round(gapMs / (1000 * 60 * 60 * 24));

        if (gapDays > 5) continue; // too far apart

        // Count overlap days: days where BOTH ads have spend > 0.
        const oldDaily = dailyByAd[oldAd.ad_id] || [];
        const newDaily = dailyByAd[newAd.ad_id] || [];
        const oldSpendDates = new Set(
          oldDaily.filter((r) => Number(r.spend || 0) > 0).map((r) => r.date_key)
        );
        const newSpendDates = new Set(
          newDaily.filter((r) => Number(r.spend || 0) > 0).map((r) => r.date_key)
        );
        let overlapDays = 0;
        for (const d of oldSpendDates) {
          if (newSpendDates.has(d)) overlapDays++;
        }

        const transitionType = overlapDays >= 5 ? 'ab_test_conclusion' : 'swap';

        // Swap date: midpoint between old's last and new's first spend date.
        const swapDateMs = (oldLast.getTime() + newFirst.getTime()) / 2;
        const swapDate = new Date(swapDateMs).toISOString().slice(0, 10);

        // Verdict logic.
        let verdict;
        if (newAd.total_spend < 10 || newAd.total_leads === 0) {
          verdict = 'insufficient_data';
        } else {
          const oldCpl = oldAd.lifetime_cpl;
          const newCpl = newAd.lifetime_cpl;
          const oldCtr = oldAd.lifetime_ctr_link;
          const newCtr = newAd.lifetime_ctr_link;
          const oldHook = oldAd.lifetime_hook_rate;
          const newHook = newAd.lifetime_hook_rate;

          // CPL improvement: positive = improved (lower CPL is better).
          const cplImprovementPct =
            oldCpl != null && oldCpl > 0 && newCpl != null
              ? ((oldCpl - newCpl) / oldCpl) * 100
              : null;

          const ctrImproved = oldCtr != null && newCtr != null && newCtr > oldCtr;
          const hookImproved = oldHook != null && newHook != null && newHook > oldHook;

          if (cplImprovementPct !== null && cplImprovementPct >= 10 && (ctrImproved || hookImproved)) {
            verdict = 'win';
          } else if (cplImprovementPct !== null && cplImprovementPct <= -10) {
            verdict = 'loss';
          } else {
            verdict = 'mixed';
          }
        }

        // Compute improvement percentages.
        const improvementCplPct =
          oldAd.lifetime_cpl != null && oldAd.lifetime_cpl > 0 && newAd.lifetime_cpl != null
            ? ((oldAd.lifetime_cpl - newAd.lifetime_cpl) / oldAd.lifetime_cpl) * 100
            : null;
        const improvementCtrPct =
          oldAd.lifetime_ctr_link != null && oldAd.lifetime_ctr_link > 0 && newAd.lifetime_ctr_link != null
            ? ((newAd.lifetime_ctr_link - oldAd.lifetime_ctr_link) / oldAd.lifetime_ctr_link) * 100
            : null;

        swaps.push({
          account_id: oldAd.account_id,
          client_display: oldAd.client_display,
          campaign_name: oldAd.campaign_name,
          old_ad_id: oldAd.ad_id,
          new_ad_id: newAd.ad_id,
          old_ad_name: oldAd.ad_name,
          new_ad_name: newAd.ad_name,
          swap_date: swapDate,
          transition_type: transitionType,
          overlap_days: overlapDays,
          gap_days: gapDays,
          old_lifetime_cpl: oldAd.lifetime_cpl,
          new_lifetime_cpl: newAd.lifetime_cpl,
          old_lifetime_ctr: oldAd.lifetime_ctr_link,
          new_lifetime_ctr: newAd.lifetime_ctr_link,
          old_lifetime_hook_rate: oldAd.lifetime_hook_rate,
          new_lifetime_hook_rate: newAd.lifetime_hook_rate,
          improvement_cpl_pct: improvementCplPct != null ? +improvementCplPct.toFixed(2) : null,
          improvement_ctr_pct: improvementCtrPct != null ? +improvementCtrPct.toFixed(2) : null,
          verdict,
        });
      }
    }
  }

  return swaps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Async / integration code (not unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

const DELAY_MS = 2000;
const PAGE_CAP = 50;
const UPSERT_CHUNK = 500;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pull ALL ads (any status) for an account.
 * Returns array of ad objects with creative fields.
 */
async function pullAllAds(account) {
  const all = [];
  const path = `/${account.id}/ads`;
  let params = {
    fields:
      'id,name,campaign{name},adset{name},effective_status,created_time,' +
      'creative{id,thumbnail_url,image_url,video_id,body,title,object_story_spec}',
    limit: 500,
  };

  let pages = 0;
  let hasMore = true;
  while (hasMore && pages < PAGE_CAP) {
    const resp = await graph(path, params);
    all.push(...(resp.data || []));

    if (resp.paging?.cursors?.after) {
      params = { ...params, after: resp.paging.cursors.after };
      pages++;
      await delay(DELAY_MS);
    } else {
      hasMore = false;
    }
  }
  if (pages >= PAGE_CAP) {
    console.warn(`  ! ${account.name}: hit ${PAGE_CAP}-page cap on ads listing`);
  }
  return all;
}

/**
 * Pull lifetime daily insights for a single ad.
 * Returns array of daily insight rows.
 */
async function pullDailyInsights(adId) {
  const all = [];
  let params = {
    date_preset: 'maximum',
    time_increment: 1,
    fields:
      'ad_id,ad_name,campaign_name,adset_name,spend,impressions,reach,' +
      'frequency,clicks,inline_link_clicks,unique_inline_link_clicks,' +
      'actions,video_thruplay_watched_actions,video_avg_time_watched_actions,' +
      'quality_ranking,engagement_rate_ranking,conversion_rate_ranking,' +
      'video_p25_watched_actions,video_p50_watched_actions,' +
      'video_p75_watched_actions,video_p95_watched_actions,' +
      'date_start,date_stop',
    // Per-window action sub-fields for attribution silent-killer diagnostic.
    // Buildable: leads_default = 7dc + 1dv, leads_7dc, leads_1dc.
    action_attribution_windows: JSON.stringify(['1d_click', '7d_click', '1d_view']),
    limit: 500,
  };

  let pages = 0;
  let hasMore = true;
  while (hasMore && pages < PAGE_CAP) {
    const resp = await graph(`/${adId}/insights`, params);
    all.push(...(resp.data || []));

    if (resp.paging?.cursors?.after) {
      params = { ...params, after: resp.paging.cursors.after };
      pages++;
      await delay(DELAY_MS);
    } else {
      hasMore = false;
    }
  }
  if (pages >= PAGE_CAP) {
    console.warn(`  ! ad ${adId}: hit ${PAGE_CAP}-page cap on daily insights`);
  }
  return all;
}

/**
 * Pull placement breakdown for an entire account (lifetime, daily grain).
 * Returns array of placement rows ready for Supabase upsert.
 */
async function pullPlacementBreakdown(account) {
  const all = [];
  let params = {
    level: 'ad',
    date_preset: 'maximum',
    time_increment: 1,
    breakdowns: 'publisher_platform,platform_position',
    fields:
      'ad_id,spend,impressions,reach,clicks,inline_link_clicks,' +
      'actions,date_start',
    limit: 500,
  };

  let pages = 0;
  let hasMore = true;
  while (hasMore && pages < PAGE_CAP) {
    const resp = await graph(`/${account.id}/insights`, params);
    const data = resp.data || [];
    for (const raw of data) {
      const spend = Number(raw.spend || 0);
      const impressions = Number(raw.impressions || 0);
      const inlineLinkClicks = Number(raw.inline_link_clicks || 0);
      const actions = raw.actions || [];
      const leads = maxAction(actions, LEAD_ACTION_TYPES);
      const lpv =
        sumActions(actions, new Set(['landing_page_view'])) ||
        sumActions(actions, new Set(['omni_landing_page_view']));

      all.push({
        id: `${raw.ad_id}:${raw.date_start}:${raw.publisher_platform || 'unknown'}:${raw.platform_position || 'unknown'}`,
        ad_id: raw.ad_id,
        account_id: account.id,
        client_display: stripClient(account.name),
        date_key: raw.date_start,
        publisher_platform: raw.publisher_platform || 'unknown',
        platform_position: raw.platform_position || 'unknown',
        spend: +spend.toFixed(2),
        impressions,
        reach: Number(raw.reach || 0),
        clicks_total: Number(raw.clicks || 0),
        inline_link_clicks: inlineLinkClicks,
        leads,
        landing_page_views: lpv,
        video_3s_views: sumActions(actions, new Set(['video_view'])),
        ctr_link: impressions > 0 ? +(inlineLinkClicks / impressions * 100).toFixed(2) : null,
        cpl: leads > 0 ? +(spend / leads).toFixed(2) : null,
        cpm: impressions > 0 ? +(spend / impressions * 1000).toFixed(2) : null,
        pulled_at: new Date().toISOString(),
      });
    }

    if (resp.paging?.cursors?.after) {
      params = { ...params, after: resp.paging.cursors.after };
      pages++;
      await delay(DELAY_MS);
    } else {
      hasMore = false;
    }
  }
  if (pages >= PAGE_CAP) {
    console.warn(`  ! ${account.name}: hit ${PAGE_CAP}-page cap on placement breakdown`);
  }
  return all;
}

/**
 * Pull demographic (age x gender) breakdown for an entire account (lifetime, daily grain).
 * Returns array of demographic rows ready for Supabase upsert.
 */
async function pullDemographicBreakdown(account) {
  const all = [];
  let params = {
    level: 'ad',
    date_preset: 'maximum',
    time_increment: 1,
    breakdowns: 'age,gender',
    fields:
      'ad_id,spend,impressions,reach,clicks,inline_link_clicks,' +
      'actions,date_start',
    limit: 500,
  };

  let pages = 0;
  let hasMore = true;
  while (hasMore && pages < PAGE_CAP) {
    const resp = await graph(`/${account.id}/insights`, params);
    const data = resp.data || [];
    for (const raw of data) {
      const spend = Number(raw.spend || 0);
      const impressions = Number(raw.impressions || 0);
      const inlineLinkClicks = Number(raw.inline_link_clicks || 0);
      const actions = raw.actions || [];
      const leads = maxAction(actions, LEAD_ACTION_TYPES);
      const lpv =
        sumActions(actions, new Set(['landing_page_view'])) ||
        sumActions(actions, new Set(['omni_landing_page_view']));

      all.push({
        id: `${raw.ad_id}:${raw.date_start}:${raw.age || 'unknown'}:${raw.gender || 'unknown'}`,
        ad_id: raw.ad_id,
        account_id: account.id,
        client_display: stripClient(account.name),
        date_key: raw.date_start,
        age: raw.age || 'unknown',
        gender: raw.gender || 'unknown',
        spend: +spend.toFixed(2),
        impressions,
        reach: Number(raw.reach || 0),
        clicks_total: Number(raw.clicks || 0),
        inline_link_clicks: inlineLinkClicks,
        leads,
        landing_page_views: lpv,
        ctr_link: impressions > 0 ? +(inlineLinkClicks / impressions * 100).toFixed(2) : null,
        cpl: leads > 0 ? +(spend / leads).toFixed(2) : null,
        pulled_at: new Date().toISOString(),
      });
    }

    if (resp.paging?.cursors?.after) {
      params = { ...params, after: resp.paging.cursors.after };
      pages++;
      await delay(DELAY_MS);
    } else {
      hasMore = false;
    }
  }
  if (pages >= PAGE_CAP) {
    console.warn(`  ! ${account.name}: hit ${PAGE_CAP}-page cap on demographic breakdown`);
  }
  return all;
}

/**
 * Upsert rows in chunks.
 */
async function upsertBatch(table, rows, conflictKey) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const slice = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase
      .from(table)
      .upsert(slice, { onConflict: conflictKey });
    if (error) throw new Error(`Supabase upsert (${table}): ${error.message}`);
  }
}

/**
 * Main entry point.
 * Parses --account flag for single-account mode, otherwise processes all accounts.
 */
async function main() {
  const t0 = Date.now();
  if (!process.env.META_ACCESS_TOKEN)
    throw new Error('META_ACCESS_TOKEN missing from .env');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from .env');

  // Parse --account flag for single-account mode.
  const args = process.argv.slice(2);
  const acctFlagIdx = args.findIndex((a) => a === '--account');
  const acctFilter = acctFlagIdx >= 0 ? args[acctFlagIdx + 1] : null;

  // Pinnacle's own ad account is for acquiring clients, not a client account.
  const EXCLUDE_ACCOUNTS = new Set(['act_25010776835219106']);

  let accounts = (await listAllAccounts()).filter((a) => !EXCLUDE_ACCOUNTS.has(a.id));
  if (acctFilter) {
    accounts = accounts.filter((a) => a.id === acctFilter);
    if (!accounts.length) throw new Error(`Account not found or excluded: ${acctFilter}`);
  }

  console.log(`meta-ad-history-backfill: processing ${accounts.length} account(s)`);

  let totalDailyRows = 0;
  let totalSummaries = 0;
  let totalSwaps = 0;
  let failures = 0;

  for (const account of accounts) {
    try {
      console.log(`  · ${account.name} (${account.id})`);

      // 1. Pull all ads for the account.
      const ads = await pullAllAds(account);
      console.log(`    ${ads.length} ads found`);
      if (!ads.length) continue;

      // 2. Extract creative metadata for each ad.
      const creativeByAd = new Map();
      for (const ad of ads) {
        creativeByAd.set(ad.id, extractCreative(ad, account));
      }

      // 3. Pull daily insights for each ad and build rows.
      const allDailyRows = [];
      const dailyByAd = {};

      for (const ad of ads) {
        try {
          const rawDays = await pullDailyInsights(ad.id);
          const rows = rawDays.map((raw) => buildDailyRow(account, raw));
          allDailyRows.push(...rows);
          dailyByAd[ad.id] = rows;
        } catch (e) {
          console.error(`    ✗ insights for ${ad.id}: ${e.message}`);
        }
      }

      // 4. Upsert daily rows.
      if (allDailyRows.length) {
        await upsertBatch('meta_ad_history', allDailyRows, 'id');
        totalDailyRows += allDailyRows.length;
        console.log(`    ${allDailyRows.length} daily rows upserted`);
      }

      // 5. Compute summaries.
      const summaries = [];
      for (const [adId, rows] of Object.entries(dailyByAd)) {
        if (!rows.length) continue;
        const creative = creativeByAd.get(adId) || {};
        const summary = computeSummary(rows, creative);
        if (summary) summaries.push(summary);
      }

      // 6. Upsert summaries.
      if (summaries.length) {
        await upsertBatch('meta_ad_history_summary', summaries, 'ad_id');
        totalSummaries += summaries.length;
        console.log(`    ${summaries.length} summaries upserted`);
      }

      // 7. Detect swaps.
      const swaps = detectSwaps(summaries, dailyByAd);

      if (swaps.length) {
        // Delete old swaps for this account, then insert fresh.
        await supabase
          .from('meta_ad_history_swaps')
          .delete()
          .eq('account_id', account.id);
        await upsertBatch('meta_ad_history_swaps', swaps, 'id');
        totalSwaps += swaps.length;
        console.log(`    ${swaps.length} swaps detected`);

        // Update replaced_by/replaces links on summary rows.
        for (const swap of swaps) {
          await supabase
            .from('meta_ad_history_summary')
            .update({ replaced_by_ad_id: swap.new_ad_id })
            .eq('ad_id', swap.old_ad_id);
          await supabase
            .from('meta_ad_history_summary')
            .update({ replaces_ad_id: swap.old_ad_id })
            .eq('ad_id', swap.new_ad_id);
        }
      }
      // 8. Pull placement breakdown for the whole account.
      const placementRows = await pullPlacementBreakdown(account);
      if (placementRows.length) {
        await upsertBatch('meta_ad_history_placement', placementRows, 'id');
        console.log(`    ${placementRows.length} placement rows`);
      }

      // 9. Pull demographic breakdown for the whole account.
      const demoRows = await pullDemographicBreakdown(account);
      if (demoRows.length) {
        await upsertBatch('meta_ad_history_demographics', demoRows, 'id');
        console.log(`    ${demoRows.length} demographic rows`);
      }
    } catch (e) {
      failures++;
      console.error(`  ✗ ${account.name}: ${e.message}`);
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `meta-ad-history-backfill done: ${totalDailyRows} daily rows | ` +
      `${totalSummaries} summaries | ${totalSwaps} swaps | ` +
      `${accounts.length} accts (${failures} fail) | ${dt}s`
  );
}

module.exports = {
  buildDailyRow,
  computeSummary,
  detectSwaps,
  extractCreative,
};

if (require.main === module) {
  main().catch((e) => {
    console.error('meta-ad-history-backfill FAIL:', e.message);
    process.exit(1);
  });
}
