#!/usr/bin/env node
// Forensic audit: pulls every active ad fresh from Meta Graph API and
// cross-checks every metric against the corresponding Supabase row.
// Run after meta-ad-sync.js to verify the snapshot is faithful.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.META_ACCESS_TOKEN;
const V = (process.env.META_API_VERSION || 'v21.0').trim();
const BASE = `https://graph.facebook.com/${V}`;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const LEAD_TYPES = [
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
  'onsite_conversion.lead',
];

async function graph(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', TOKEN);
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  return j;
}

const maxAction = (actions, types) => {
  const map = new Map((actions || []).map((a) => [a.action_type, Number(a.value || 0)]));
  return types.reduce((m, t) => Math.max(m, map.get(t) || 0), 0);
};
const sumAction = (actions, type) =>
  (actions || []).filter((a) => a.action_type === type).reduce((s, a) => s + Number(a.value || 0), 0);

// Tolerance: Meta data updates every few minutes, so we allow small numeric drift.
const tol = (a, b, abs = 0.05, rel = 0.005) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const A = Number(a), B = Number(b);
  if (isNaN(A) || isNaN(B)) return false;
  const diff = Math.abs(A - B);
  return diff <= abs || diff <= Math.max(Math.abs(A), Math.abs(B)) * rel;
};

(async () => {
  // 1. Pull all active accounts the token can see.
  const accts = (await graph('/me/adaccounts', { fields: 'id,account_id,name,account_status,business{name}', limit: 100 })).data;
  const activeAccts = accts.filter((a) => a.account_status === 1 && !a.name.toLowerCase().includes('dry test'));
  console.log(`API: ${accts.length} accounts visible, ${activeAccts.length} active non-test`);

  // 2. Pull insights for every active account × both presets.
  const expectedById = new Map(); // "ad_id:preset" -> {fields...}
  for (const preset of ['last_7d', 'maximum']) {
    for (const acct of activeAccts) {
      const ins = await graph(`/${acct.id}/insights`, {
        level: 'ad',
        date_preset: preset,
        fields:
          'ad_id,ad_name,campaign_name,adset_name,spend,impressions,reach,frequency,cpm,' +
          'unique_inline_link_clicks,unique_inline_link_click_ctr,cost_per_unique_inline_link_click,' +
          'inline_link_clicks,actions',
        limit: 500,
        filtering: JSON.stringify([{ field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE'] }]),
      });
      for (const ad of ins.data || []) {
        const spend = Number(ad.spend || 0);
        const imp = Number(ad.impressions || 0);
        const reach = Number(ad.reach || 0);
        const cpm = Number(ad.cpm || 0);
        const uClk = Number(ad.unique_inline_link_clicks || 0);
        const uCtr = Number(ad.unique_inline_link_click_ctr || 0);
        const cpuc = ad.cost_per_unique_inline_link_click ? Number(ad.cost_per_unique_inline_link_click) : null;
        const ilc = Number(ad.inline_link_clicks || 0);
        const leads = maxAction(ad.actions, LEAD_TYPES);
        const lpv = sumAction(ad.actions, 'landing_page_view') || sumAction(ad.actions, 'omni_landing_page_view');
        const cpl = leads > 0 ? +(spend / leads).toFixed(2) : null;
        const lpv2lead = leads > 0 && lpv > 0 ? +(lpv / leads).toFixed(2) : null;
        const imp2lead = leads > 0 ? Math.round(imp / leads) : null;
        expectedById.set(`${ad.ad_id}:${preset}`, {
          ad_id: ad.ad_id, ad_name: ad.ad_name, campaign_name: ad.campaign_name, adset_name: ad.adset_name,
          account_id: acct.id, account_name: acct.name,
          date_preset: preset, spend, impressions: imp, reach, frequency: Number(ad.frequency || 0) || null,
          cpm, unique_clicks: uClk, unique_ctr: uCtr, cost_per_unique_click: cpuc,
          inline_link_clicks: ilc, leads, cpl, landing_page_views: lpv, lpv_to_lead: lpv2lead, imp_to_lead: imp2lead,
        });
      }
    }
  }
  console.log(`API: ${expectedById.size} ad×preset rows expected\n`);

  // 3. Pull all Supabase rows.
  const { data: dbRows, error } = await supabase.from('meta_ad_snapshot').select('*');
  if (error) throw error;
  const dbById = new Map(dbRows.map((r) => [r.id, r]));
  console.log(`DB:  ${dbRows.length} rows actually stored\n`);

  // 4. Diff.
  const issues = [];
  const FIELDS = [
    ['spend', 0.10, 0.01],
    ['impressions', 5, 0.005],
    ['reach', 5, 0.005],
    ['cpm', 0.30, 0.01],
    ['unique_clicks', 1, 0.02],
    ['unique_ctr', 0.10, 0.02],
    ['cost_per_unique_click', 0.20, 0.02],
    ['inline_link_clicks', 1, 0.02],
    ['leads', 0, 0],          // exact
    ['cpl', 0.10, 0.01],
    ['landing_page_views', 1, 0.02],
    ['frequency', 0.05, 0.01],
  ];

  // 4a. Missing in DB
  for (const [id, exp] of expectedById) {
    if (!dbById.has(id)) issues.push(`MISSING in DB: ${id} (${exp.account_name} | ${exp.ad_name})`);
  }
  // 4b. Orphan in DB (in DB but not in API)
  for (const [id, db] of dbById) {
    if (!expectedById.has(id)) issues.push(`ORPHAN in DB: ${id} (${db.account_name} | ${db.ad_name}) — should have been pruned`);
  }

  // 4c. Field-level diffs for matching rows
  let matched = 0, fieldMismatches = 0;
  for (const [id, exp] of expectedById) {
    const db = dbById.get(id);
    if (!db) continue;
    matched++;
    for (const [f, abs, rel] of FIELDS) {
      if (!tol(exp[f], db[f], abs, rel)) {
        issues.push(`FIELD ${f}: ${id} (${exp.account_name} | ${exp.ad_name}) — API=${exp[f]} DB=${db[f]}`);
        fieldMismatches++;
      }
    }
    // String fields exact match
    for (const sf of ['ad_name', 'campaign_name', 'adset_name', 'account_id', 'account_name', 'ad_id']) {
      if ((exp[sf] || '') !== (db[sf] || '')) {
        issues.push(`STRING ${sf}: ${id} — API="${exp[sf]}" DB="${db[sf]}"`);
        fieldMismatches++;
      }
    }
    // Date preset
    if (exp.date_preset !== db.date_preset) {
      issues.push(`PRESET: ${id} — API=${exp.date_preset} DB=${db.date_preset}`);
      fieldMismatches++;
    }
  }

  // Report
  console.log(`=== AUDIT RESULTS ===`);
  console.log(`Active accounts:     ${activeAccts.length}`);
  console.log(`API ad×preset rows:  ${expectedById.size}`);
  console.log(`DB rows:             ${dbRows.length}`);
  console.log(`Matched:             ${matched}`);
  console.log(`Field mismatches:    ${fieldMismatches}`);
  console.log(`Total issues:        ${issues.length}`);
  if (issues.length) {
    console.log(`\n--- ISSUES (first 50) ---`);
    issues.slice(0, 50).forEach((i) => console.log(`  ${i}`));
    if (issues.length > 50) console.log(`  ...and ${issues.length - 50} more`);
  } else {
    console.log(`\n✓ ZERO mismatches. Every field matches Meta API source-of-truth within tolerance.`);
  }
})().catch((e) => { console.error('AUDIT FAIL:', e.message); process.exit(1); });
