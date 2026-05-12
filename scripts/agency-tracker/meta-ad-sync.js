#!/usr/bin/env node
// Pulls Meta Ads insights for every active client account (last_7d + maximum)
// and upserts into Supabase `meta_ad_snapshot`. Designed to run on a 60s cron.
// Realtime-subscribed Lovable frontend reacts to row changes immediately.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = (process.env.META_API_VERSION || 'v21.0').trim();
const BASE = `https://graph.facebook.com/${API_VERSION}`;

const { resolveAdCopy } = require('./lib/ad-copy-variants');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Meta returns the same lead under multiple action_type buckets (e.g. `lead` and
// `onsite_conversion.lead_grouped` both = 1 for the SAME underlying lead). Summing
// these double-counts. We take MAX across the canonical lead types — matches Meta
// Ads Manager's "Results" column for lead-gen campaigns.
const LEAD_ACTION_TYPES = [
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
  'onsite_conversion.lead',
];

const sumActions = (actions, types) =>
  (actions || [])
    .filter((a) => types.has(a.action_type))
    .reduce((s, a) => s + Number(a.value || 0), 0);

const maxAction = (actions, types) => {
  const map = new Map((actions || []).map((a) => [a.action_type, Number(a.value || 0)]));
  return types.reduce((m, t) => Math.max(m, map.get(t) || 0), 0);
};

// Strip "X Pinnacle" / "@Pinnacle" / etc. so the UI shows just "Greenstone", "C&M", etc.
const stripClient = (name) =>
  name
    .replace(/[\s@]?[xX]\s*Pinn?acle/g, '')
    .replace(/@pinnacle/gi, '')
    .replace(/Pinnacle/g, '')
    .replace(/[\s&@x]+$/g, '')
    .trim();

async function graph(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', TOKEN);

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
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
  return data.filter(
    (a) => a.account_status === 1 && !a.name.toLowerCase().includes('dry test')
  );
}

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
      'cost_per_inline_link_click,actions,cost_per_action_type',
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
      fields: 'creative{id,thumbnail_url,image_url,video_id,effective_object_story_id}',
    });
    const c = data.creative || {};
    return {
      creative_id: c.id || null,
      creative_thumbnail_url: c.thumbnail_url || null,
      creative_image_url: c.image_url || null,
      creative_video_id: c.video_id || null,
    };
  } catch {
    return {
      creative_id: null,
      creative_thumbnail_url: null,
      creative_image_url: null,
      creative_video_id: null,
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
  const { data: cached } = await supabase
    .from('meta_ad_snapshot')
    .select('ad_id, creative_id, creative_thumbnail_url, creative_image_url, creative_video_id, creative_fetched_at')
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

  for (const preset of ['last_7d', 'maximum']) {
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
    [...presetsOk.entries()].filter(([, n]) => n === 2).map(([id]) => id)
  );
  const pruned = await pruneStale(seenIds, fullyOk);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `meta-ad-sync ✓ ${allRows.length} rows | ${pruned} stale removed | ${accounts.length} accts (${failures} fail) | ${dt}s`
  );
}

main().catch((e) => {
  console.error('meta-ad-sync FAIL:', e.message);
  process.exit(1);
});
