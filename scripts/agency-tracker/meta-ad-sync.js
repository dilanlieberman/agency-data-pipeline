#!/usr/bin/env node
// Pulls Meta Ads insights for every active client account (last_7d + maximum)
// and upserts into Supabase `meta_ad_snapshot`. Designed to run on a 60s cron.
// Realtime-subscribed Lovable frontend reacts to row changes immediately.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const {
  TOKEN,
  LEAD_ACTION_TYPES,
  sumActions,
  maxAction,
  stripClient,
  graph,
  listActiveAccounts,
} = require('./lib/meta-helpers');

const { resolveAdCopy } = require('./lib/ad-copy-variants');
const { derive } = require('./lib/meta-derive');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function pullAds(account, datePreset) {
  const { data } = await graph(`/${account.id}/insights`, {
    level: 'ad',
    date_preset: datePreset,
    fields:
      'ad_id,ad_name,campaign_name,adset_name,spend,impressions,reach,frequency,cpm,' +
      // Use unique_inline_link_clicks (link only), NOT unique_clicks (any click).
      // Meta UI's "Unique CTR (link click-through rate)" is unique_inline_link_click_ctr.
      'unique_inline_link_clicks,unique_inline_link_click_ctr,' +
      'cost_per_unique_inline_link_click,inline_link_clicks,inline_link_click_ctr,' +
      'cost_per_inline_link_click,actions,cost_per_action_type,' +
      // Phase 1 (agency ad manager): clicks for CTR-all, video actions for hook/hold/avg-watch.
      // 3-sec view count comes from the actions array (action_type='video_view') — NOT a top-level field.
      'clicks,video_avg_time_watched_actions,video_thruplay_watched_actions',
    limit: 500,
    filtering: JSON.stringify([
      { field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE'] },
    ]),
  });
  return data || [];
}

function buildRow(account, datePreset, ad) {
  const spend = Number(ad.spend || 0);
  const impressions = Number(ad.impressions || 0);
  const reach = Number(ad.reach || 0);
  const cpm = Number(ad.cpm || 0);
  // unique LINK clicks (clicks to landing page), NOT unique_clicks (any click).
  const uniqueLinkClicks = Number(ad.unique_inline_link_clicks || 0);
  const uniqueLinkCtr = Number(ad.unique_inline_link_click_ctr || 0);
  const costPerUniqueLink = ad.cost_per_unique_inline_link_click
    ? Number(ad.cost_per_unique_inline_link_click)
    : null;
  const inlineLinkClicks = Number(ad.inline_link_clicks || 0);
  const actions = ad.actions || [];

  const leads = maxAction(actions, LEAD_ACTION_TYPES);
  const lpv =
    sumActions(actions, new Set(['landing_page_view'])) ||
    sumActions(actions, new Set(['omni_landing_page_view']));

  const cpl = leads > 0 ? +(spend / leads).toFixed(2) : null;
  const lpvToLead = leads > 0 && lpv > 0 ? +(lpv / leads).toFixed(2) : null;
  const impToLead = leads > 0 ? Math.round(impressions / leads) : null;

  // Phase 1 (agency ad manager) — new raw fields from Meta + derived metrics.
  // Action-array fields come back with action_type='video_view' for the relevant
  // event types; sum across them.
  const clicksTotal = Number(ad.clicks || 0);
  // 3-sec views: Meta's `video_view` action_type IS the 3-second video play count.
  // Extract from the existing `actions` array (not a top-level field in Insights API v21).
  const v3sViews = sumActions(actions, new Set(['video_view']));
  const vThruplays = sumActions(ad.video_thruplay_watched_actions || [], new Set(['video_view']));
  const vAvgWatchSeconds = Number(
    (ad.video_avg_time_watched_actions || []).find((a) => a.action_type === 'video_view')?.value || 0
  );
  // Crude creative_type proxy: any video signal = 'video', else 'image'.
  // 'carousel' detection deferred to a future pass that joins the creative cache.
  const creativeType = (v3sViews > 0 || vThruplays > 0 || vAvgWatchSeconds > 0) ? 'video' : 'image';

  const derived = derive({
    spend, impressions, reach, clicks: clicksTotal,
    inline_link_clicks: inlineLinkClicks,
    unique_inline_link_clicks: uniqueLinkClicks,
    leads, landing_page_views: lpv,
    video_3s_views: v3sViews,
    video_thruplays: vThruplays,
    video_avg_watch_seconds: vAvgWatchSeconds,
  });
  const round2 = (n) => (n === null ? null : +n.toFixed(2));

  return {
    id: `${ad.ad_id}:${datePreset}`,
    ad_id: ad.ad_id,
    ad_name: ad.ad_name || '',
    campaign_name: ad.campaign_name || '',
    adset_name: ad.adset_name || '',
    account_id: account.id,
    account_name: account.name,
    client_display: stripClient(account.name),
    business_name: account.business?.name || '',
    date_preset: datePreset,
    spend: +spend.toFixed(2),
    impressions,
    reach,
    frequency: Number(ad.frequency || 0) || null,
    cpm: +cpm.toFixed(2),
    // schema columns named "unique_clicks" / "unique_ctr" / "cost_per_unique_click"
    // for backwards-compat, but they now hold unique LINK metrics (matches Meta UI).
    unique_clicks: uniqueLinkClicks,
    unique_ctr: +uniqueLinkCtr.toFixed(2),
    inline_link_clicks: inlineLinkClicks,
    cost_per_unique_click: costPerUniqueLink ? +costPerUniqueLink.toFixed(2) : null,
    leads,
    cpl,
    landing_page_views: lpv,
    lpv_to_lead: lpvToLead,
    imp_to_lead: impToLead,
    // Phase 1 (agency ad manager) — new columns. Migration:
    // supabase/migrations/2026-05-23-agency-ad-manager.sql
    clicks_total: clicksTotal,
    video_3s_views: v3sViews,
    video_thruplays: vThruplays,
    video_avg_watch_seconds: vAvgWatchSeconds || null,
    creative_type: creativeType,
    ctr_link: round2(derived.ctr_link),
    ctr_all: round2(derived.ctr_all),
    // unique_ctr is already written above from Meta's unique_inline_link_click_ctr — same value as derive().
    lpv_to_lead_pct: round2(derived.lpv_to_lead_pct),
    imp_to_lead_v2: derived.imp_to_lead,
    cpc_link: round2(derived.cpc_link),
    hook_rate: round2(derived.hook_rate),
    hold_rate: round2(derived.hold_rate),
    low_signal: derived.low_signal,
    effective_status: 'ACTIVE',
    pulled_at: new Date().toISOString(),
    // Ad copy preview — looked up by ad_name signature against the canonical
    // variant table in lib/ad-copy-variants.js. Returns null when the ad name
    // doesn't match a known concept; the dashboard renders "—" in that case.
    ...(() => {
      const copy = resolveAdCopy({
        ad_name: ad.ad_name || '',
        business_name: account.business?.name || account.name || '',
      });
      return copy
        ? {
            ad_copy_concept: copy.concept_key,
            ad_copy_concept_name: copy.concept_name,
            ad_copy_primary: copy.primary_text,
            ad_copy_headline: copy.headline,
            ad_copy_description: copy.description,
          }
        : {
            ad_copy_concept: null,
            ad_copy_concept_name: null,
            ad_copy_primary: null,
            ad_copy_headline: null,
            ad_copy_description: null,
          };
    })(),
  };
}

async function upsertBatch(rows) {
  // Chunk to avoid request size limits.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('meta_ad_snapshot')
      .upsert(slice, { onConflict: 'id' });
    if (error) throw new Error(`Supabase upsert: ${error.message}`);
  }
}

// Fetch creative visual (image/video thumbnail) for a single ad_id.
// Meta returns thumbnail_url for both image AND video ads (auto-generated still
// frame for videos). Returns { creative_id, creative_thumbnail_url,
// creative_image_url, creative_video_id } — all null on failure.
async function pullAdCreative(adId) {
  try {
    const data = await graph(`/${adId}`, {
      // Pulls:
      //   - created_time → Cohort viz anchor (Spec §7.2 Tab 4.6)
      //   - creative.thumbnail_url / video_id / image_url → preview
      //   - creative.body / title → ad copy shown in per-ad drawer
      //   - object_story_spec.video_data.message / link_data.message → newer-format ads carry body here
      fields:
        'created_time,creative{id,thumbnail_url,image_url,video_id,effective_object_story_id,body,title,object_story_spec}',
    });
    const c = data.creative || {};
    const oss = c.object_story_spec || {};
    const story = oss.video_data || oss.link_data || {};
    const body = c.body || story.message || null;
    const title = c.title || story.title || null;
    return {
      creative_id: c.id || null,
      creative_thumbnail_url: c.thumbnail_url || null,
      creative_image_url: c.image_url || null,
      creative_video_id: c.video_id || null,
      ad_created_time: data.created_time || null,
      meta_creative_body: body,
      meta_creative_title: title,
    };
  } catch {
    return {
      creative_id: null,
      creative_thumbnail_url: null,
      creative_image_url: null,
      creative_video_id: null,
      ad_created_time: null,
      meta_creative_body: null,
      meta_creative_title: null,
    };
  }
}

// Backfill creative visuals on rows that don't have them yet. Cache in DB so
// we only hit Meta once per ad_id, refreshing every 6 hours since fbcdn
// signed URLs can expire. Returns the count of ads we re-fetched creative for.
const CREATIVE_REFRESH_MS = 6 * 60 * 60 * 1000;

async function fetchMissingCreatives(rows) {
  if (!rows.length) return 0;
  const uniqueAdIds = [...new Set(rows.map((r) => r.ad_id))];
  const refreshCutoff = new Date(Date.now() - CREATIVE_REFRESH_MS).toISOString();

  // Find which ad_ids already have a cached thumbnail that's still fresh.
  // Also pulls `ad_created_time` so we don't re-fetch it every cycle (it never changes).
  const { data: cached } = await supabase
    .from('meta_ad_snapshot')
    .select('ad_id, creative_id, creative_thumbnail_url, creative_image_url, creative_video_id, creative_fetched_at, ad_created_time, meta_creative_body, meta_creative_title')
    .in('ad_id', uniqueAdIds)
    .not('creative_thumbnail_url', 'is', null)
    .gte('creative_fetched_at', refreshCutoff);
  const cacheMap = new Map();
  for (const c of cached || []) cacheMap.set(c.ad_id, c);

  // Apply cached creatives to rows immediately.
  let cacheHits = 0;
  let needsFetch = new Set();
  for (const row of rows) {
    const hit = cacheMap.get(row.ad_id);
    if (hit) {
      row.creative_id = hit.creative_id;
      row.creative_thumbnail_url = hit.creative_thumbnail_url;
      row.creative_image_url = hit.creative_image_url;
      row.creative_video_id = hit.creative_video_id;
      row.creative_fetched_at = hit.creative_fetched_at;
      row.ad_created_time = hit.ad_created_time;
      row.meta_creative_body = hit.meta_creative_body;
      row.meta_creative_title = hit.meta_creative_title;
      cacheHits++;
    } else {
      needsFetch.add(row.ad_id);
    }
  }

  // Fetch creatives we don't have yet — one Graph call per ad_id (small N, ~10-40).
  const fetched = new Map();
  const fetchedAt = new Date().toISOString();
  for (const adId of needsFetch) {
    const c = await pullAdCreative(adId);
    fetched.set(adId, c);
  }
  for (const row of rows) {
    const f = fetched.get(row.ad_id);
    if (!f) continue;
    row.creative_id = f.creative_id;
    row.creative_thumbnail_url = f.creative_thumbnail_url;
    row.creative_image_url = f.creative_image_url;
    row.creative_video_id = f.creative_video_id;
    row.creative_fetched_at = fetchedAt;
    row.ad_created_time = f.ad_created_time;
    row.meta_creative_body = f.meta_creative_body;
    row.meta_creative_title = f.meta_creative_title;
  }
  return needsFetch.size;
}

async function pruneStale(seenIds, succeededAccountIds) {
  // Delete rows for ads no longer ACTIVE — but ONLY for accounts whose pull succeeded.
  // Otherwise a transient Graph API failure on one account would wipe all its rows.
  if (!succeededAccountIds.size) return 0;

  const { data: existing, error } = await supabase
    .from('meta_ad_snapshot')
    .select('id, account_id')
    .in('account_id', [...succeededAccountIds]);
  if (error) throw new Error(`Supabase select: ${error.message}`);

  const stale = existing.map((r) => r.id).filter((id) => !seenIds.has(id));

  if (stale.length) {
    const { error: delErr } = await supabase
      .from('meta_ad_snapshot')
      .delete()
      .in('id', stale);
    if (delErr) throw new Error(`Supabase delete: ${delErr.message}`);
  }
  return stale.length;
}

async function main() {
  const t0 = Date.now();
  if (!TOKEN) throw new Error('META_ACCESS_TOKEN missing from .env');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from .env');

  const accounts = await listActiveAccounts();
  const allRows = [];
  const seenIds = new Set();
  // Track accounts where BOTH presets pulled cleanly — only prune within those.
  const presetsOk = new Map(); // account_id -> count of successful presets
  let failures = 0;

  for (const preset of ['last_7d', 'last_30d', 'maximum']) {
    for (const acct of accounts) {
      try {
        const ads = await pullAds(acct, preset);
        for (const ad of ads) {
          const row = buildRow(acct, preset, ad);
          allRows.push(row);
          seenIds.add(row.id);
        }
        presetsOk.set(acct.id, (presetsOk.get(acct.id) || 0) + 1);
      } catch (e) {
        failures++;
        console.error(`  ✗ ${acct.name} (${preset}): ${e.message}`);
      }
    }
  }

  // Backfill creative thumbnails for any ads we don't already have cached.
  // Most cycles this is a no-op (cache hit on every ad_id).
  try {
    const fetched = await fetchMissingCreatives(allRows);
    if (fetched) console.log(`  · fetched creative for ${fetched} new ads`);
  } catch (e) {
    console.error(`  · creative fetch error (non-fatal): ${e.message}`);
  }

  await upsertBatch(allRows);

  const fullyOk = new Set(
    [...presetsOk.entries()].filter(([, n]) => n === 3).map(([id]) => id)
  );
  const pruned = await pruneStale(seenIds, fullyOk);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `meta-ad-sync ✓ ${allRows.length} rows | ${pruned} stale removed | ${accounts.length} accts (${failures} fail) | ${dt}s`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom date-range mode (Phase 1, agency ad manager)
// ─────────────────────────────────────────────────────────────────────────────
//
// `node meta-ad-sync.js --account act_X --from YYYY-MM-DD --to YYYY-MM-DD`
//
// Pulls Meta Insights for the exact date window, writes rows with
// date_preset = `custom:<from>:<to>` into meta_ad_snapshot. Skips the pull if
// a row for this (account, range) already exists with pulled_at < 1h old.

const CUSTOM_RANGE_CACHE_WINDOW_MS = 60 * 60 * 1000;

async function pullCustomRange({ account, from, to }) {
  const datePreset = `custom:${from}:${to}`;
  const cutoffIso = new Date(Date.now() - CUSTOM_RANGE_CACHE_WINDOW_MS).toISOString();

  // 1) Cache check
  const { data: cached, error: selErr } = await supabase
    .from('meta_ad_snapshot')
    .select('ad_id, pulled_at')
    .eq('account_id', account.id)
    .eq('date_preset', datePreset)
    .gte('pulled_at', cutoffIso)
    .limit(1);
  if (selErr) throw new Error(`cache lookup: ${selErr.message}`);
  if (cached && cached.length > 0) {
    return { cached: true, count: 0 };
  }

  // 2) Pull from Meta — same field list as pullAds(), but with time_range instead of date_preset.
  const { data: ads } = await graph(`/${account.id}/insights`, {
    level: 'ad',
    time_range: JSON.stringify({ since: from, until: to }),
    fields:
      'ad_id,ad_name,campaign_name,adset_name,spend,impressions,reach,frequency,cpm,' +
      'unique_inline_link_clicks,unique_inline_link_click_ctr,' +
      'cost_per_unique_inline_link_click,inline_link_clicks,inline_link_click_ctr,' +
      'cost_per_inline_link_click,actions,cost_per_action_type,' +
      'clicks,video_avg_time_watched_actions,video_thruplay_watched_actions',
    limit: 500,
    filtering: JSON.stringify([
      { field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE'] },
    ]),
  });
  const rows = (ads || []).map((ad) => buildRow(account, datePreset, ad));

  if (rows.length > 0) {
    await upsertBatch(rows);
  }
  return { cached: false, count: rows.length, pulled_at: new Date().toISOString() };
}

// CLI mode dispatcher: returns true if we ran custom-range mode (so main() should not run).
async function maybeRunCustomRangeCli() {
  const args = process.argv.slice(2);
  const getFlag = (k) => {
    const i = args.findIndex((a) => a === k);
    return i >= 0 ? args[i + 1] : null;
  };
  const account = getFlag('--account');
  const from = getFlag('--from');
  const to = getFlag('--to');
  if (!account || !from || !to) return false;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('--from and --to must be YYYY-MM-DD');
  }

  // Resolve account from active list.
  const accounts = await listActiveAccounts();
  const acct = accounts.find((a) => a.id === account);
  if (!acct) throw new Error(`account not found / not active: ${account}`);

  const result = await pullCustomRange({ account: acct, from, to });
  console.log(JSON.stringify(result, null, 2));
  return true;
}

module.exports = {
  pullCustomRange,
  buildRow,
  CUSTOM_RANGE_CACHE_WINDOW_MS,
};

if (require.main === module) {
  (async () => {
    const ranCustom = await maybeRunCustomRangeCli();
    if (!ranCustom) await main();
  })().catch((e) => {
    console.error('meta-ad-sync FAIL:', e.message);
    process.exit(1);
  });
}
