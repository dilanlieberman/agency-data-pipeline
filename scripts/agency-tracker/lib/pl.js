const { PPA_RATE, CLOSER_COMP } = require('./config');

// P&L constants
const RETAINER_RATE = 2500;
const TRIAL_RATE = 250;
const SEO_RATE = 197;
const SMS_COST = 0.0166;
const GHL_SUB = 297;
const GOCARDLESS_FEE_PCT = 0.01;
const GOCARDLESS_FEE_FLAT = 0.20;
const WHOP_FEE_PCT = 0.03;

/**
 * Compute full P&L for a given month.
 *
 * @param {Object} data
 * @param {Array}  data.ppaRows          - [{ appts_qualified, amount_owed }]
 * @param {Array}  data.retainerClients   - [{ status, monthly_rate }]
 * @param {Array}  data.setterRows        - [{ commission_owed }]
 * @param {Object} data.closerRow         - { retainer_closes, trial_closes, builder_closes, builder_downsell_closes, retainer_upgrades }
 * @param {Array}  data.builderPipeline   - [{ entry_fee_paid }]
 * @param {number} data.totalSmsSent
 * @param {Object} data.manualRevenue     - { builder_revshare, website_revshare, whop_revenue, seo_client_count, total_payments_count, total_payments_amount }
 * @returns {Object} { revenue, costs, profit, margin_pct }
 */
function computePL(data) {
  const {
    ppaRows = [],
    retainerClients = [],
    setterRows = [],
    closerRow = null,
    builderPipeline = [],
    totalSmsSent = 0,
    manualRevenue = {},
  } = data;

  // --- Revenue ---
  const ppa = ppaRows.reduce((sum, r) => sum + (r.appts_qualified || 0), 0) * PPA_RATE;

  const activeRetainers = retainerClients.filter(r => r.status === 'active');
  const retainer = activeRetainers.length * RETAINER_RATE;

  // Trial closes from closer row
  const trialCloses = closerRow ? (closerRow.trial_closes || 0) : 0;
  const trial = trialCloses * TRIAL_RATE;

  const builder_entry = builderPipeline.reduce((sum, b) => sum + (b.entry_fee_paid || 0), 0);

  const builder_revshare = manualRevenue.builder_revshare || 0;
  const website_revshare = manualRevenue.website_revshare || 0;

  const seoClientCount = manualRevenue.seo_client_count || 0;
  const seo = seoClientCount * SEO_RATE;

  const revenueTotal = ppa + retainer + trial + builder_entry + builder_revshare + website_revshare + seo;

  // --- Costs ---
  const sms = roundCents(totalSmsSent * SMS_COST);

  const setter_commission = setterRows.reduce((sum, s) => sum + (s.commission_owed || 0), 0);

  // Tony's commission uses CLOSER_COMP rates
  const closer_commission = closerRow
    ? (closerRow.retainer_closes || 0) * CLOSER_COMP.retainer_close +
      (closerRow.trial_closes || 0) * CLOSER_COMP.trial_close +
      (closerRow.builder_closes || 0) * CLOSER_COMP.builder_close +
      (closerRow.builder_downsell_closes || 0) * CLOSER_COMP.builder_downsell +
      (closerRow.retainer_upgrades || 0) * CLOSER_COMP.retainer_upgrade
    : 0;

  const ghl_sub = GHL_SUB;

  // GoCardless: 1% of each payment + $0.20 per transaction
  const paymentsCount = manualRevenue.total_payments_count || 0;
  const paymentsAmount = manualRevenue.total_payments_amount || 0;
  const gocardless_fees = roundCents(paymentsAmount * GOCARDLESS_FEE_PCT + paymentsCount * GOCARDLESS_FEE_FLAT);

  // Whop: 3% of Whop revenue
  const whopRevenue = manualRevenue.whop_revenue || 0;
  const whop_fees = roundCents(whopRevenue * WHOP_FEE_PCT);

  const costsTotal = sms + setter_commission + closer_commission + ghl_sub + gocardless_fees + whop_fees;

  const profit = roundCents(revenueTotal - costsTotal);
  const margin_pct = revenueTotal > 0
    ? parseFloat(((profit / revenueTotal) * 100).toFixed(2))
    : 0;

  return {
    revenue: {
      ppa,
      retainer,
      trial,
      builder_entry,
      builder_revshare,
      website_revshare,
      seo,
      total: revenueTotal,
    },
    costs: {
      sms,
      setter_commission,
      closer_commission,
      ghl_sub,
      gocardless_fees,
      whop_fees,
      total: costsTotal,
    },
    profit,
    margin_pct,
  };
}

function roundCents(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  computePL,
  // Export constants for testing / reuse
  RETAINER_RATE,
  TRIAL_RATE,
  SEO_RATE,
  SMS_COST,
  GHL_SUB,
  GOCARDLESS_FEE_PCT,
  GOCARDLESS_FEE_FLAT,
  WHOP_FEE_PCT,
};
