// Shared Meta Ads API helpers.
// Extracted from meta-ad-sync.js + meta-ad-daily-sync.js so that
// the backfill script (meta-ad-backfill.js) can reuse them too.

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = (process.env.META_API_VERSION || 'v21.0').trim();
const BASE = `https://graph.facebook.com/${API_VERSION}`;

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

/**
 * Sum action values for action_types in the given Set.
 * @param {Array} actions - Meta actions array (may be null/undefined)
 * @param {Set} types - Set of action_type strings to match
 * @returns {number}
 */
const sumActions = (actions, types) =>
  (actions || [])
    .filter((a) => types.has(a.action_type))
    .reduce((s, a) => s + Number(a.value || 0), 0);

/**
 * Max action value across the given action types (array).
 * Used for lead counts where Meta duplicates the same lead across multiple buckets.
 * @param {Array} actions - Meta actions array (may be null/undefined)
 * @param {Array} types - Array of action_type strings
 * @returns {number}
 */
const maxAction = (actions, types) => {
  const map = new Map((actions || []).map((a) => [a.action_type, Number(a.value || 0)]));
  return types.reduce((m, t) => Math.max(m, map.get(t) || 0), 0);
};

/**
 * Strip "X Pinnacle" / "@Pinnacle" / etc. so the UI shows just "Greenstone", "C&M", etc.
 */
const stripClient = (name) =>
  name
    .replace(/[\s@]?[xX]\s*Pinn?acle/g, '')
    .replace(/@pinnacle/gi, '')
    .replace(/Pinnacle/g, '')
    .replace(/[\s&@x]+$/g, '')
    .trim();

/**
 * Make a GET request to the Meta Graph API with retry (3 attempts, backoff).
 * @param {string} path - Graph API path (e.g. '/me/adaccounts')
 * @param {Object} params - Query parameters (access_token added automatically)
 * @returns {Object} Parsed JSON response
 */
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

/**
 * List active ad accounts (account_status === 1, excluding 'dry test' names).
 * @returns {Array} Filtered account objects
 */
async function listActiveAccounts() {
  const { data } = await graph('/me/adaccounts', {
    fields: 'id,account_id,name,account_status,timezone_name,business{name}',
    limit: 100,
  });
  return (data || []).filter(
    (a) => a.account_status === 1 && !a.name.toLowerCase().includes('dry test')
  );
}

/**
 * List ALL ad accounts (excluding only 'dry test' names — no account_status filter).
 * Used by the backfill script to pull historical data for paused/disabled accounts too.
 * @returns {Array} Filtered account objects
 */
async function listAllAccounts() {
  const { data } = await graph('/me/adaccounts', {
    fields: 'id,account_id,name,account_status,timezone_name,business{name}',
    limit: 100,
  });
  return (data || []).filter(
    (a) => !a.name.toLowerCase().includes('dry test')
  );
}

module.exports = {
  TOKEN,
  API_VERSION,
  BASE,
  LEAD_ACTION_TYPES,
  sumActions,
  maxAction,
  stripClient,
  graph,
  listActiveAccounts,
  listAllAccounts,
};
