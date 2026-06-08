#!/usr/bin/env node
// meta-ad-history-sync.js
//
// Twice-daily sync that keeps meta_ad_history, meta_ad_history_summary, and
// meta_ad_history_swaps current for ACTIVE accounts only.
//
// Thin wrapper around the backfill's pure functions — scopes to the last 7 days
// of daily data (overlap catches late-arriving Meta data).
//
// Cron: every 12h (0 */12 * * *), alongside meta-ad-daily-sync.js (different tables, no conflict).

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const {
  graph,
  listActiveAccounts,
  stripClient,
  sumActions,
  maxAction,
  LEAD_ACTION_TYPES,
} = require('./lib/meta-helpers');

const {
  buildDailyRow,
  computeSummary,
  detectSwaps,
  extractCreative,
  pullAllAds,
} = require('./meta-ad-history-backfill');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const LOOKBACK_DAYS = 7;
const DELAY_MS = 2000;
const PAGE_CAP = 20;
const UPSERT_CHUNK = 500;

const INSIGHT_FIELDS =
  'ad_id,ad_name,campaign_name,adset_name,spend,impressions,reach,' +
  'frequency,clicks,inline_link_clicks,unique_inline_link_clicks,actions,' +
  'video_avg_time_watched_actions,video_thruplay_watched_actions,' +
  'quality_ranking,engagement_rate_ranking,conversion_rate_ranking,' +
  'video_p25_watched_actions,video_p50_watched_actions,' +
  'video_p75_watched_actions,video_p95_watched_actions,' +
  'date_start,date_stop';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Pull placement breakdown for an account within a date window.
 */
async function pullPlacementBreakdown(account, sinceDate, untilDate) {
  const all = [];
  let params = {
    level: 'ad',
    time_range: JSON.stringify({ since: sinceDate, until: untilDate }),
    time_increment: '1',
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

    if (resp.paging?.cursors?.after && resp.paging?.next) {
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
 * Pull demographic (age x gender) breakdown for an account within a date window.
 */
async function pullDemographicBreakdown(account, sinceDate, untilDate) {
  const all = [];
  let params = {
    level: 'ad',
    time_range: JSON.stringify({ since: sinceDate, until: untilDate }),
    time_increment: '1',
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

    if (resp.paging?.cursors?.after && resp.paging?.next) {
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
 * Upsert rows in chunks to keep payload sizes manageable.
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

// ─────────────────────────────────────────────────────────────────────────────
// Data pull
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull daily insights for a 7-day window at the account level with ad breakdown.
 * No status filter — catches paused ads that spent in the window.
 */
async function pullRecentInsights(account, sinceDate, untilDate) {
  const allRows = [];
  let params = {
    level: 'ad',
    time_range: JSON.stringify({ since: sinceDate, until: untilDate }),
    time_increment: '1',
    fields: INSIGHT_FIELDS,
    // Per-window action sub-fields for attribution silent-killer diagnostic.
    // Must match the backfill's pullDailyInsights so buildDailyRow can derive
    // leads_7dc / leads_1dc / leads_default consistently.
    action_attribution_windows: JSON.stringify(['1d_click', '7d_click', '1d_view']),
    limit: 500,
  };

  let pages = 0;
  let hasMore = true;
  while (hasMore && pages < PAGE_CAP) {
    const resp = await graph(`/${account.id}/insights`, params);
    allRows.push(...(resp.data || []));

    if (resp.paging?.cursors?.after && resp.paging?.next) {
      params = { ...params, after: resp.paging.cursors.after };
      pages++;
      await delay(DELAY_MS);
    } else {
      hasMore = false;
    }
  }
  if (pages >= PAGE_CAP) {
    console.warn(`  ! ${account.name}: hit ${PAGE_CAP}-page cap on insights`);
  }
  return allRows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary recomputation
// ─────────────────────────────────────────────────────────────────────────────

// Creative fields. The sync now fetches live creatives each run (so new ads get
// their image within 4h); these are the fields we fall back to from the existing
// summary row when the live creative fetch fails or returns nothing.
const CREATIVE_FIELDS = [
  'primary_text',
  'headline',
  'description',
  'call_to_action',
  'creative_type',
  'creative_id',
  'creative_thumbnail_url',
  'creative_video_id',
  'creative_video_url',
  'ad_created_time',
  'effective_status',
];

/**
 * Read all daily rows for a given ad_id from meta_ad_history (full history).
 */
async function readAllDailyRows(adId) {
  const rows = [];
  let from = 0;
  const pageSize = 1000;
  let done = false;

  while (!done) {
    const { data, error } = await supabase
      .from('meta_ad_history')
      .select('*')
      .eq('ad_id', adId)
      .order('date_key', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`read daily rows (${adId}): ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) {
      done = true;
    } else {
      from += pageSize;
    }
  }
  return rows;
}

/**
 * Read the existing summary row for an ad (to preserve creative fields).
 */
async function readExistingSummary(adId) {
  const { data, error } = await supabase
    .from('meta_ad_history_summary')
    .select('*')
    .eq('ad_id', adId)
    .maybeSingle();
  if (error) throw new Error(`read summary (${adId}): ${error.message}`);
  return data;
}

/**
 * Build a creative-fields object from an existing summary row.
 * Falls back to empty strings/null for missing fields.
 */
function extractCreativeFromSummary(existingSummary) {
  const creative = {};
  for (const field of CREATIVE_FIELDS) {
    creative[field] = existingSummary?.[field] || null;
  }
  return creative;
}

// ─────────────────────────────────────────────────────────────────────────────
// Swap detection (per-campaign scope)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read all summary rows for a given (account_id, campaign_name).
 */
async function readCampaignSummaries(accountId, campaignName) {
  const rows = [];
  let from = 0;
  const pageSize = 1000;
  let done = false;

  while (!done) {
    const { data, error } = await supabase
      .from('meta_ad_history_summary')
      .select('*')
      .eq('account_id', accountId)
      .eq('campaign_name', campaignName)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`read campaign summaries: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) {
      done = true;
    } else {
      from += pageSize;
    }
  }
  return rows;
}

/**
 * Read all daily rows for a set of ad_ids (needed for detectSwaps overlap calc).
 * Returns Map of ad_id → rows.
 */
async function readDailyForAds(adIds) {
  const dailyByAd = {};
  for (const adId of adIds) {
    dailyByAd[adId] = await readAllDailyRows(adId);
  }
  return dailyByAd;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-account sync
// ─────────────────────────────────────────────────────────────────────────────

async function syncAccount(account, sinceDate, untilDate) {
  // 1. Pull daily insights for 7-day window.
  const raw = await pullRecentInsights(account, sinceDate, untilDate);
  if (!raw.length) {
    console.log(`    0 rows (no spend in window)`);
    return { daily: 0, summaries: 0, swaps: 0 };
  }

  // 2. Build daily rows via backfill's buildDailyRow().
  const dailyRows = raw.map((r) => buildDailyRow(account, r));

  // 3. Upsert daily rows to meta_ad_history (chunked at 500).
  await upsertBatch('meta_ad_history', dailyRows, 'id');
  console.log(`    ${dailyRows.length} daily rows upserted`);

  // Collect affected ad_ids and campaign_names.
  const affectedAdIds = [...new Set(dailyRows.map((r) => r.ad_id))];
  const affectedCampaigns = [...new Set(dailyRows.map((r) => r.campaign_name))];

  // Fetch live creatives + effective_status for the account in one call. This is
  // what lets a newly-launched ad get its image within this 4h sync instead of
  // waiting for the daily backfill. Best-effort: if it fails (e.g. lost ad
  // permission) we fall back to whatever creative is already in the summary.
  const creativeByAd = {};
  try {
    const ads = await pullAllAds(account);
    for (const ad of ads) creativeByAd[ad.id] = extractCreative(ad, account);
  } catch (e) {
    console.warn(`    ! creative fetch failed (${stripClient(account.name)}): ${e.message} — keeping existing`);
  }

  // 4. For each affected ad: read ALL daily rows, resolve creative (prefer the
  //    freshly-fetched one, preserving any lazy-loaded video URL), recompute
  //    summary, upsert.
  const summaries = [];
  let newCreatives = 0;
  for (const adId of affectedAdIds) {
    const allDaily = await readAllDailyRows(adId);
    if (!allDaily.length) continue;

    const existingSummary = await readExistingSummary(adId);
    const fetched = creativeByAd[adId];
    let creative;
    if (fetched) {
      creative = { ...fetched };
      // The /ads endpoint doesn't return the lazy-loaded video URL — keep the
      // one the backfill already resolved rather than nulling it.
      if (!creative.creative_video_url && existingSummary?.creative_video_url) {
        creative.creative_video_url = existingSummary.creative_video_url;
      }
      if (!existingSummary?.creative_thumbnail_url && creative.creative_thumbnail_url) {
        newCreatives++;
      }
    } else {
      creative = extractCreativeFromSummary(existingSummary);
    }
    const summary = computeSummary(allDaily, creative);
    if (summary) summaries.push(summary);
  }

  if (summaries.length) {
    await upsertBatch('meta_ad_history_summary', summaries, 'ad_id');
    console.log(
      `    ${summaries.length} summaries recomputed` +
        (newCreatives ? ` (${newCreatives} new creatives fetched)` : '')
    );
  }

  // 5. For each affected campaign: re-run swap detection.
  let swapCount = 0;
  for (const campaignName of affectedCampaigns) {
    const campaignSummaries = await readCampaignSummaries(account.id, campaignName);
    if (campaignSummaries.length < 2) continue;

    // Read daily rows for all ads in this campaign (needed for overlap calc).
    const campaignAdIds = campaignSummaries.map((s) => s.ad_id);
    const dailyByAd = await readDailyForAds(campaignAdIds);

    const swaps = detectSwaps(campaignSummaries, dailyByAd);

    // Delete old swaps for this (account_id, campaign_name).
    await supabase
      .from('meta_ad_history_swaps')
      .delete()
      .eq('account_id', account.id)
      .eq('campaign_name', campaignName);

    if (swaps.length) {
      await upsertBatch('meta_ad_history_swaps', swaps, 'id');
      swapCount += swaps.length;

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
  }

  if (swapCount) console.log(`    ${swapCount} swaps detected`);

  // 6. Pull placement breakdown for the window.
  const placementRows = await pullPlacementBreakdown(account, sinceDate, untilDate);
  if (placementRows.length) {
    await upsertBatch('meta_ad_history_placement', placementRows, 'id');
    console.log(`    ${placementRows.length} placement rows`);
  }

  // 7. Pull demographic breakdown for the window.
  const demoRows = await pullDemographicBreakdown(account, sinceDate, untilDate);
  if (demoRows.length) {
    await upsertBatch('meta_ad_history_demographics', demoRows, 'id');
    console.log(`    ${demoRows.length} demographic rows`);
  }

  return { daily: dailyRows.length, summaries: summaries.length, swaps: swapCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  if (!process.env.META_ACCESS_TOKEN)
    throw new Error('META_ACCESS_TOKEN missing from .env');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from .env');

  const until = new Date();
  const since = new Date(until.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const sinceStr = isoDate(since);
  const untilStr = isoDate(until);

  const EXCLUDE_ACCOUNTS = new Set(['act_25010776835219106']);
  const accounts = (await listActiveAccounts()).filter((a) => !EXCLUDE_ACCOUNTS.has(a.id));
  console.log(
    `meta-ad-history-sync: ${accounts.length} active account(s) | window ${sinceStr}..${untilStr}`
  );

  let totalDaily = 0;
  let totalSummaries = 0;
  let totalSwaps = 0;
  let failures = 0;

  for (const account of accounts) {
    try {
      console.log(`  · ${stripClient(account.name)} (${account.id})`);
      const result = await syncAccount(account, sinceStr, untilStr);
      totalDaily += result.daily;
      totalSummaries += result.summaries;
      totalSwaps += result.swaps;
    } catch (e) {
      failures++;
      console.error(`  ✗ ${account.name}: ${e.message}`);
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `meta-ad-history-sync done: ${totalDaily} daily rows | ` +
      `${totalSummaries} summaries | ${totalSwaps} swaps | ` +
      `${accounts.length} accts (${failures} fail) | ${dt}s`
  );
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error('meta-ad-history-sync FAIL:', e.message);
    process.exit(1);
  });
}
