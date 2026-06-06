/**
 * GHL Billing Scraper (usage-records API edition)
 *
 * Records per-sub-account wallet/usage spend + the agency total into Supabase.
 *
 * HOW IT WORKS (rewritten 2026-06-05):
 *   GHL replaced the old Naive-UI wallet page (which this scraper used to DOM-scrape)
 *   with a new "Billing Dashboard". Instead of scraping reshuffled HTML, we now attach to
 *   the authenticated Chrome (CDP), open the billing page, and INTERCEPT the two JSON APIs
 *   the page itself calls:
 *     - .../warehouse/v2/location-usage-records/<companyId>?limit=500
 *         → per-sub-account spend, keyed by month: { locationName, months: { "YYYY-MM": { amount, count } } }
 *     - .../warehouse/v3/company-usage-records/<companyId>
 *         → agency totals: { totalSpendAcrossMonths, monthOverMonthChanges: [{ toMonth, toAmount }] }
 *   This is robust to visual restyles — it only breaks if GHL changes the API itself, in which
 *   case we throw loudly (we NEVER silently write zeros, which was the old failure mode).
 *
 * Usage:
 *   node scripts/agency-tracker/ghl-billing-scraper.js              # daily: 6 key accounts
 *   node scripts/agency-tracker/ghl-billing-scraper.js --full        # bi-weekly: ALL accounts
 *
 * Requires: Chrome running with --remote-debugging-port=9222 --user-data-dir=$HOME/chrome-debug-ghl
 *           (logged into the GHL agency).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const BILLING_URL = 'https://app.gohighlevel.com/settings/billing?tab=wallet_transactions';
const CDP_URL = 'http://localhost:9222';

// JSON endpoints the billing dashboard fires; we intercept their responses.
const LOCATION_USAGE_RE = /warehouse\/v2\/location-usage-records\//;
const COMPANY_USAGE_RE = /warehouse\/v3\/company-usage-records\//;

// Key sub-accounts to scrape daily (must match GHL locationName exactly).
const DAILY_ACCOUNTS = [
  'dilan sub acc 1',
  'dilan sub acc 2',
  'coleton sub acc 1',
  'coleton sub acc 2',
  'tony sub acc 1',
  'cesar sub acc 1',
];

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getPage() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  if (!contexts.length) throw new Error('No browser contexts — is Chrome running with debug profile?');
  // Open a throwaway tab so we don't disturb any existing tab; closed in run()'s finally.
  const page = await contexts[0].newPage();
  return { browser, page };
}

// Loads the billing dashboard and captures the two usage-records JSON payloads.
// Throws if either fails to arrive (loud failure — never writes zeros silently).
async function captureUsageRecords(page) {
  let locationUsage = null;
  let companyUsage = null;

  page.on('response', async (resp) => {
    const url = resp.url();
    try {
      if (LOCATION_USAGE_RE.test(url)) {
        // The page fires this endpoint more than once — an all-accounts call
        // (limit=500) plus narrower scoped calls. Keep the fullest payload, not
        // the last one to arrive (which may hold a single account).
        const json = await resp.json();
        if (json && Array.isArray(json.data) && (!locationUsage || json.data.length > locationUsage.data.length)) {
          locationUsage = json;
        }
      } else if (COMPANY_USAGE_RE.test(url)) {
        companyUsage = await resp.json();
      }
    } catch (e) {
      // non-JSON / already-consumed body — ignore
    }
  });

  const captured = () => locationUsage && Array.isArray(locationUsage.data) && companyUsage;

  // The per-location + company usage calls fire when these sub-views render.
  // The SPA sometimes serves cached state without re-fetching, so a single pass can
  // miss them — retry with a fresh navigation (which reliably re-fires the fetches).
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !captured(); attempt++) {
    if (attempt > 1) console.log(`[billing] usage-records not captured — retry ${attempt}/${MAX_ATTEMPTS}`);
    await page.goto(BILLING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);

    for (const label of ['Usage Overview', 'By Sub-Account']) {
      const el = page.locator(`text=/${label.replace(/[- ]/g, '[- ]?')}/i`).first();
      if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
        await el.click().catch(() => {});
        await page.waitForTimeout(4000);
      }
    }

    // Poll for the payloads to arrive this attempt.
    for (let i = 0; i < 15 && !captured(); i++) {
      await page.waitForTimeout(1000);
    }
  }

  if (!locationUsage || !Array.isArray(locationUsage.data)) {
    throw new Error('location-usage-records not captured — GHL billing API/UI may have changed');
  }
  if (!companyUsage) {
    throw new Error('company-usage-records not captured — GHL billing API/UI may have changed');
  }
  return { locations: locationUsage.data, company: companyUsage };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Agency-wide total for the given month. Prefer the company endpoint's month-over-month
// figure (matches the old "unfiltered wallet total"); fall back to summing locations.
function agencyMonthTotal(company, monthKey, locations) {
  const mom = (company.monthOverMonthChanges || []).find((c) => c.toMonth === monthKey);
  if (mom && typeof mom.toAmount === 'number') return mom.toAmount;
  return locations.reduce((sum, L) => sum + ((L.months && L.months[monthKey] && L.months[monthKey].amount) || 0), 0);
}

async function run() {
  const isFullScan = process.argv.includes('--full');
  const today = new Date().toISOString().split('T')[0];
  const month = today.substring(0, 7);

  console.log(`[billing] ${isFullScan ? 'FULL' : 'daily'} scan starting — ${today} (usage-records API)`);

  const { page } = await getPage();

  try {
    const { locations, company } = await captureUsageRecords(page);
    console.log(`[billing] captured ${locations.length} sub-accounts from usage-records`);

    const wanted = isFullScan ? locations.map((L) => L.locationName) : DAILY_ACCOUNTS;

    const results = [];
    for (const name of wanted) {
      const loc = locations.find((x) => x.locationName === name);
      if (!loc) {
        console.log(`  [skip] "${name}" not in usage-records`);
        continue;
      }
      const amount = loc.months && loc.months[month] ? loc.months[month].amount : 0;
      const total = round2(amount);
      console.log(`[billing] ${name}: $${total.toFixed(2)} (${month})`);
      results.push({ sub_account: name, date: today, month, total_spent: total, breakdown: {} });
    }

    const agencyTotal = round2(agencyMonthTotal(company, month, locations));
    console.log(`[billing] agency ${month} total: $${agencyTotal.toFixed(2)}`);

    // Write per-account spend
    for (const r of results) {
      const { error } = await supabase
        .from('ghl_billing')
        .upsert({
          sub_account: r.sub_account,
          date: r.date,
          month: r.month,
          total_spent: r.total_spent,
          breakdown: r.breakdown,
        }, { onConflict: 'sub_account,date' });
      if (error) console.error(`  supabase error for ${r.sub_account}: ${error.message}`);
    }

    // Write agency total to agency_daily
    const { error: agErr } = await supabase
      .from('agency_daily')
      .upsert({
        date: today,
        ghl_wallet_spent: agencyTotal,
      }, { onConflict: 'date' });
    if (agErr) console.error(`  agency_daily upsert error: ${agErr.message}`);

    console.log(`[billing] done. ${results.length} accounts written.`);

    // Write full report if --full
    if (isFullScan) {
      const report = {
        date: today,
        month,
        agency_total: agencyTotal,
        accounts: results.map((r) => ({ name: r.sub_account, total: r.total_spent })),
      };
      const reportPath = require('path').join(__dirname, '../../data/agency-tracker/billing-report.json');
      require('fs').mkdirSync(require('path').dirname(reportPath), { recursive: true });
      require('fs').writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`[billing] full report written to ${reportPath}`);
    }
  } finally {
    // Close our throwaway tab; leave the shared Chrome session running.
    try { await page.close(); } catch (e) { /* ignore */ }
  }
}

// NOTE: we attach to Chrome over CDP and never close the browser (it's the shared,
// manually-logged-in GHL session). The live CDP websocket keeps Node's event loop
// alive, so we must exit explicitly — otherwise the process hangs forever and cron
// runs pile up.
run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[billing] fatal:', err.message);
    process.exit(1);
  });
