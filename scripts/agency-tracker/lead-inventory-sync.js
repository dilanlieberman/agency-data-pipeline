#!/usr/bin/env node
/**
 * Lead Inventory Sync
 *
 * Scans all CSV files in data/leads/all_contacts_final/,
 * merges with tracking.json usage data, and upserts to
 * the lead_inventory Supabase table.
 *
 * Usage: node scripts/agency-tracker/lead-inventory-sync.js
 *        node scripts/agency-tracker/lead-inventory-sync.js --create-table
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const LEADS_DIR = path.join(__dirname, '../../data/leads/all_contacts_final');
const TRACKING_PATH = path.join(__dirname, '../../data/leads/tracking.json');

const SERVICES = ['remodelers', 'roofing', 'landscaping', 'pools_and_patios', 'fencing', 'misc'];

// Count lines in a file without loading it all into memory
function countCsvRows(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    // Subtract 1 for header row
    return Math.max(0, lines.length - 1);
  } catch (err) {
    console.error(`[lead-inventory] Could not read ${filePath}: ${err.message}`);
    return 0;
  }
}

function loadTracking() {
  try {
    return JSON.parse(fs.readFileSync(TRACKING_PATH, 'utf8'));
  } catch (err) {
    console.error(`[lead-inventory] Could not read tracking.json: ${err.message}`);
    return {};
  }
}

function scanInventory() {
  const tracking = loadTracking();
  const inventory = [];

  for (const service of SERVICES) {
    const serviceDir = path.join(LEADS_DIR, service);
    if (!fs.existsSync(serviceDir)) {
      console.log(`[lead-inventory] Skipping ${service} — directory not found`);
      continue;
    }

    const files = fs.readdirSync(serviceDir).filter(f => f.endsWith('.csv'));

    for (const file of files) {
      const state = path.basename(file, '.csv'); // e.g. "CA"
      const filePath = path.join(serviceDir, file);
      const totalLeads = countCsvRows(filePath);

      // Tracking key format: "remodelers/CA"
      const trackingKey = `${service}/${state}`;
      const trackingEntry = tracking[trackingKey] || {};

      const usedLeads = trackingEntry.usedRows || 0;
      const remainingLeads = Math.max(0, totalLeads - usedLeads);
      const lastUploadDate = trackingEntry.lastUploadDate || null;

      inventory.push({
        service,
        state,
        total_leads: totalLeads,
        used_leads: usedLeads,
        remaining_leads: remainingLeads,
        last_upload_date: lastUploadDate,
        updated_at: new Date().toISOString(),
      });
    }
  }

  return inventory;
}

async function createTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS lead_inventory (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      service TEXT NOT NULL,
      state TEXT NOT NULL,
      total_leads INT DEFAULT 0,
      used_leads INT DEFAULT 0,
      remaining_leads INT DEFAULT 0,
      last_upload_date DATE,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(service, state)
    );
    ALTER TABLE lead_inventory ENABLE ROW LEVEL SECURITY;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'lead_inventory' AND policyname = 'Allow anonymous read'
      ) THEN
        CREATE POLICY "Allow anonymous read" ON lead_inventory FOR SELECT USING (true);
      END IF;
    END $$;
  `;

  const { error } = await supabase.rpc('exec_sql', { sql_text: sql }).catch(() => ({ error: { message: 'rpc not available' } }));

  if (error) {
    // Try direct SQL via the REST API — if rpc doesn't exist, run statements individually
    console.log('[lead-inventory] rpc exec_sql not available, trying direct table creation...');

    // Try to select from the table to see if it exists
    const { error: selectErr } = await supabase.from('lead_inventory').select('id').limit(1);
    if (selectErr && selectErr.code === '42P01') {
      console.log('[lead-inventory] Table does not exist. Run this SQL in Supabase SQL Editor:');
      console.log(sql);
      process.exit(1);
    } else if (selectErr) {
      console.error(`[lead-inventory] Supabase error: ${selectErr.message}`);
      process.exit(1);
    } else {
      console.log('[lead-inventory] Table lead_inventory already exists');
    }
  } else {
    console.log('[lead-inventory] Table created successfully');
  }
}

async function syncToSupabase(inventory) {
  // Upsert in batches of 50
  const BATCH_SIZE = 50;
  let upserted = 0;

  for (let i = 0; i < inventory.length; i += BATCH_SIZE) {
    const batch = inventory.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('lead_inventory')
      .upsert(batch, { onConflict: 'service,state' });

    if (error) {
      throw new Error(`Upsert failed at batch ${i}: ${error.message}`);
    }
    upserted += batch.length;
  }

  return upserted;
}

function printSummary(inventory) {
  console.log('\n=== LEAD INVENTORY SUMMARY ===\n');

  // By service
  const byService = {};
  for (const row of inventory) {
    if (!byService[row.service]) {
      byService[row.service] = { total: 0, used: 0, remaining: 0, states: 0, exhausted: [] };
    }
    byService[row.service].total += row.total_leads;
    byService[row.service].used += row.used_leads;
    byService[row.service].remaining += row.remaining_leads;
    byService[row.service].states += 1;
    if (row.remaining_leads === 0 && row.total_leads > 0) {
      byService[row.service].exhausted.push(row.state);
    }
  }

  let grandTotal = 0, grandUsed = 0, grandRemaining = 0;

  for (const [service, data] of Object.entries(byService)) {
    console.log(`${service}: ${data.total.toLocaleString()} total | ${data.used.toLocaleString()} used | ${data.remaining.toLocaleString()} remaining | ${data.states} states`);
    if (data.exhausted.length > 0) {
      console.log(`  Exhausted: ${data.exhausted.join(', ')}`);
    }
    grandTotal += data.total;
    grandUsed += data.used;
    grandRemaining += data.remaining;
  }

  console.log(`\nGRAND TOTAL: ${grandTotal.toLocaleString()} leads | ${grandUsed.toLocaleString()} used | ${grandRemaining.toLocaleString()} remaining`);
  console.log(`Utilization: ${grandTotal > 0 ? ((grandUsed / grandTotal) * 100).toFixed(1) : 0}%`);
}

async function main() {
  const args = process.argv.slice(2);

  console.log(`[lead-inventory] starting at ${new Date().toISOString()}`);

  // Create table if requested
  if (args.includes('--create-table')) {
    await createTable();
  }

  // Scan CSV files and merge with tracking
  const inventory = scanInventory();
  console.log(`[lead-inventory] scanned ${inventory.length} service/state combos`);

  if (inventory.length === 0) {
    console.log('[lead-inventory] no CSV files found — nothing to sync');
    return;
  }

  // Upsert to Supabase
  const upserted = await syncToSupabase(inventory);
  console.log(`[lead-inventory] upserted ${upserted} rows to lead_inventory`);

  // Print summary
  printSummary(inventory);

  console.log(`[lead-inventory] done at ${new Date().toISOString()}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[lead-inventory] fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { scanInventory, syncToSupabase };
