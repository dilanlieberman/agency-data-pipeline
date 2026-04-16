/**
 * GHL Billing Scraper
 *
 * Scrapes wallet/transaction spending from GHL billing page per sub-account.
 * Connects to Chrome debug instance on port 9222 (requires chrome-debug-ghl profile).
 *
 * Usage:
 *   node scripts/agency-tracker/ghl-billing-scraper.js              # daily: 6 key accounts
 *   node scripts/agency-tracker/ghl-billing-scraper.js --full        # bi-weekly: ALL accounts
 *
 * Requires: Chrome running with --remote-debugging-port=9222 --user-data-dir=$HOME/chrome-debug-ghl
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const BILLING_URL = 'https://app.gohighlevel.com/settings/billing?tab=wallet_transactions';
const CDP_URL = 'http://localhost:9222';

// Key sub-accounts to scrape daily
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
  const page = contexts[0].pages()[0] || await contexts[0].newPage();
  return { browser, page };
}

async function navigateToBilling(page) {
  await page.goto(BILLING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  // Verify we're on the billing page
  const url = page.url();
  if (!url.includes('billing')) throw new Error('Not on billing page — may need to re-login');
}

async function getSubAccountDropdown(page) {
  // The "Select Sub-Account" dropdown is consistently at index 2
  const sel = page.locator('.n-base-selection').nth(2);
  await sel.waitFor({ state: 'visible', timeout: 10000 });
  return sel;
}

async function scrapeAccount(page, accountName, dropdown) {
  // Clear any previous selection
  try {
    const clearBtn = dropdown.locator('.n-base-clear').first();
    if (await clearBtn.isVisible({ timeout: 2000 })) {
      await clearBtn.click();
      await page.waitForTimeout(2000);
    }
  } catch (e) {
    // No clear button — first run or already cleared
  }

  // Click dropdown to open and clear any existing text
  await dropdown.click();
  await page.waitForTimeout(500);
  // Select all + delete to clear the input
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);

  // Type to search
  await page.keyboard.type(accountName, { delay: 30 });
  await page.waitForTimeout(3000);

  // Click the matching option
  const option = page.locator('.n-base-select-option__content').filter({ hasText: accountName }).first();
  const exists = await option.isVisible({ timeout: 5000 }).catch(() => false);
  if (!exists) {
    console.log(`  [skip] "${accountName}" not found in dropdown`);
    await page.keyboard.press('Escape');
    return null;
  }
  await option.click();
  await page.waitForTimeout(5000);

  // Read table data
  const data = await page.evaluate(() => {
    const table = document.querySelector('table');
    if (!table) return null;
    const rows = Array.from(table.querySelectorAll('tr'));

    // Summary row has total
    const summaryText = rows[0]?.textContent?.trim() || '';
    const totalMatch = summaryText.match(/\$([\d,.]+)/);
    const total = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, '')) : 0;

    // Parse each product row
    const products = {};
    for (const row of rows.slice(2)) { // skip header + summary
      const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.textContent.trim());
      if (cells.length >= 4) {
        const name = cells[0].replace(/\s*\$[\d,.]+$/, '').trim();
        const amount = parseFloat(cells[3]) || 0;
        if (name && amount > 0) {
          products[name] = amount;
        }
      }
    }

    return { total, products };
  });

  return data;
}

async function getAllSubAccounts(page, dropdown) {
  // Open dropdown and scroll to collect all account names
  await dropdown.click();
  await page.waitForTimeout(1000);

  const accounts = new Set();
  let prevCount = 0;
  let scrollAttempts = 0;

  while (scrollAttempts < 20) {
    const options = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.n-base-select-option__content'));
      return items.map(i => i.textContent.trim()).filter(t => !t.startsWith('$') && t.length > 0);
    });
    options.forEach(o => accounts.add(o));

    if (accounts.size === prevCount) {
      scrollAttempts++;
    } else {
      scrollAttempts = 0;
    }
    prevCount = accounts.size;

    // Scroll the dropdown list
    await page.evaluate(() => {
      const list = document.querySelector('.v-vl');
      if (list) list.scrollTop += 300;
    });
    await page.waitForTimeout(300);
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  return Array.from(accounts).sort();
}

async function run() {
  const isFullScan = process.argv.includes('--full');
  const today = new Date().toISOString().split('T')[0];
  const month = today.substring(0, 7);

  console.log(`[billing] ${isFullScan ? 'FULL' : 'daily'} scan starting — ${today}`);

  const { browser, page } = await getPage();

  try {
    await navigateToBilling(page);
    console.log('[billing] on billing page');

    const dropdown = await getSubAccountDropdown(page);

    let accountsToScrape;
    if (isFullScan) {
      accountsToScrape = await getAllSubAccounts(page, dropdown);
      console.log(`[billing] full scan: ${accountsToScrape.length} sub-accounts found`);
    } else {
      accountsToScrape = DAILY_ACCOUNTS;
    }

    const results = [];

    for (const account of accountsToScrape) {
      console.log(`[billing] scraping: ${account}`);
      const data = await scrapeAccount(page, account, dropdown);
      if (data) {
        console.log(`  total: $${data.total.toFixed(2)}`);
        results.push({
          sub_account: account,
          date: today,
          month,
          total_spent: data.total,
          breakdown: data.products,
        });
      }
    }

    // Also scrape the agency-wide total (no filter)
    try {
      const clearBtn = dropdown.locator('.n-base-clear').first();
      if (await clearBtn.isVisible({ timeout: 1000 })) {
        await clearBtn.click();
        await page.waitForTimeout(5000);
      }
    } catch (e) { /* no clear button */ }

    const agencyTotal = await page.evaluate(() => {
      const table = document.querySelector('table');
      if (!table) return 0;
      const summary = table.querySelector('tr')?.textContent?.trim() || '';
      const m = summary.match(/\$([\d,.]+)/);
      return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
    });
    console.log(`[billing] agency total: $${agencyTotal.toFixed(2)}`);

    // Write to Supabase
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

    console.log(`[billing] done. ${results.length} accounts scraped.`);

    // Write full report if --full
    if (isFullScan) {
      const report = {
        date: today,
        month,
        agency_total: agencyTotal,
        accounts: results.map(r => ({
          name: r.sub_account,
          total: r.total_spent,
          breakdown: r.breakdown,
        })),
      };
      const reportPath = require('path').join(__dirname, '../../data/agency-tracker/billing-report.json');
      require('fs').mkdirSync(require('path').dirname(reportPath), { recursive: true });
      require('fs').writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`[billing] full report written to ${reportPath}`);
    }
  } finally {
    // Don't close the browser — it's the user's Chrome session
  }
}

run().catch(err => {
  console.error('[billing] fatal:', err.message);
  process.exit(1);
});
