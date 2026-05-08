#!/usr/bin/env node
// Pulls Meta Ads insights for every active client account (last_7d + maximum)
// and upserts into Supabase `meta_ad_snapshot`. Designed to run on a 60s cron.
// Realtime-subscribed Lovable frontend reacts to row changes immediately.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = (process.env.META_API_VERSION || 'v21.0').trim();
const BASE = `https://graph.facebook.com/${API_VERSION}`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LEAD_ACTION_TYPES = new Set([
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
  'onsite_conversion.lead',
]);

const sumActions = (actions, types) =>
  (actions || [])
    .filter((a) => types.has(a.action_type))
    .reduce((s, a) => s + Number(a.value || 0), 0);

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
      'unique_clicks,unique_ctr,inline_link_clicks,inline_link_click_ctr,' +
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
  const uniqueClicks = Number(ad.unique_clicks || 0);
  const uniqueCtr = Number(ad.unique_ctr || 0);
  const inlineLinkClicks = Number(ad.inline_link_clicks || 0);
  const actions = ad.actions || [];

  const leads = sumActions(actions, LEAD_ACTION_TYPES);
  const lpv =
    sumActions(actions, new Set(['landing_page_view'])) ||
    sumActions(actions, new Set(['omni_landing_page_view']));

  const cpl = leads > 0 ? +(spend / leads).toFixed(2) : null;
  const cpuc = uniqueClicks > 0 ? +(spend / uniqueClicks).toFixed(2) : null;
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
    unique_clicks: uniqueClicks,
    unique_ctr: +uniqueCtr.toFixed(2),
    inline_link_clicks: inlineLinkClicks,
    cost_per_unique_click: cpuc,
    leads,
    cpl,
    landing_page_views: lpv,
    lpv_to_lead: lpvToLead,
    imp_to_lead: impToLead,
    effective_status: 'ACTIVE',
    pulled_at: new Date().toISOString(),
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
