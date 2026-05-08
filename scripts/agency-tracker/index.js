require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');

const LOCK_FILE = path.join(__dirname, '.sync.lock');
const ACCOUNT_TIMEOUT_MS = 60_000; // 60s max per account

// Process lock — prevent cron pileup
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
      try { process.kill(pid, 0); return false; } // process alive → skip
      catch (e) { /* stale lock */ }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch (e) { return false; }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* ok */ }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

const { createGhlClient } = require('./lib/ghl-client');
const {
  computeSetterMetrics,
  computeCloserMetrics,
  computePpaClientMetrics,
  computeLeadBankRunway,
  computeAgencySnapshot,
} = require('./lib/metrics');
const {
  upsertSetterDaily,
  upsertCloserDaily,
  upsertPpaClientDaily,
  upsertAgencyDaily,
  insertAlert,
} = require('./lib/supabase-client');
const { checkAlerts } = require('./lib/alerts');
const { SETTERS, CLOSER, getToken } = require('./lib/config');

const LEAD_BANK_TOTAL = 400_000;
const DAILY_BURN = 4500;

const VAULT_PINNACLE = '/home/claude/lifeos/vault/Pillars/Pinnacle/_index.md';

function updateVaultPinnacle(snapshot, setterRows, closerRow) {
  if (!fs.existsSync(VAULT_PINNACLE)) {
    console.log('[tracker] vault pinnacle file not found — skipping');
    return;
  }

  let content = fs.readFileSync(VAULT_PINNACLE, 'utf8');
  const dateStr = today();
  const timestamp = new Date().toISOString().slice(11, 16);

  // Update frontmatter fields
  if (content.includes('last_touched:')) {
    content = content.replace(/last_touched:\s*\d{4}-\d{2}-\d{2}/, `last_touched: ${dateStr}`);
  }

  // Add or update current_mrr in frontmatter
  const mrr = snapshot.total_retainer_mrr || 0;
  const activeClients = snapshot.total_closes || 0;

  if (content.includes('current_mrr:')) {
    content = content.replace(/current_mrr:.*/, `current_mrr: ${mrr}`);
  } else {
    content = content.replace(/^(---\n)/, `$1current_mrr: ${mrr}\n`);
  }

  if (content.includes('active_clients:')) {
    content = content.replace(/active_clients:.*/, `active_clients: ${activeClients}`);
  } else {
    content = content.replace(/^(---\n)/, `$1active_clients: ${activeClients}\n`);
  }

  if (content.includes('last_tracker_update:')) {
    content = content.replace(/last_tracker_update:.*/, `last_tracker_update: ${dateStr}T${timestamp}`);
  } else {
    content = content.replace(/^(---\n)/, `$1last_tracker_update: ${dateStr}T${timestamp}\n`);
  }

  // Add tracker log section if missing
  if (!content.includes('## Tracker Log')) {
    content += '\n\n## Tracker Log\n';
  }

  // Build setter summary
  const setterSummary = setterRows.map(r =>
    `${r.setter_name}: ${r.closed_trial + r.closed_ppa} closes (${r.close_rate}%)`
  ).join(', ');

  const closerSummary = closerRow
    ? `Tony: ${closerRow.retainer_closes + closerRow.trial_closes} closes`
    : 'Tony: no data';

  const logLine = `- **${dateStr} ${timestamp}** — MRR: $${mrr} | Closes: ${snapshot.total_closes} | PPA: $${snapshot.total_ppa_revenue} | ${setterSummary} | ${closerSummary} | Alerts: ${snapshot.alerts || 0}\n`;

  content += logLine;

  fs.writeFileSync(VAULT_PINNACLE, content, 'utf8');
  // Restore claude ownership — tracker runs as root but vault is claude-owned
  try { require('child_process').execSync(`chown claude:claude "${VAULT_PINNACLE}"`); } catch (e) {}
  console.log(`[tracker] vault updated: MRR=$${mrr}, clients=${activeClients}`);
}

function today() {
  return new Date().toISOString().split('T')[0];
}

async function buildStageMap(client, locationId) {
  const pipelines = await client.getPipelines(locationId);
  const map = {};
  for (const pipeline of pipelines) {
    for (const stage of (pipeline.stages || [])) {
      map[stage.id] = stage.name;
    }
  }
  return map;
}

async function syncSetter(name, locationId) {
  const token = getToken(locationId);
  const client = createGhlClient(token);
  const stageMap = await buildStageMap(client, locationId);
  const pipelines = await client.getPipelines(locationId);

  let allOpps = [];
  for (const pipeline of pipelines) {
    const opps = await client.getOpportunities(locationId, pipeline.id);
    allOpps.push(...opps);
  }

  const todayOpps = allOpps.filter(o => {
    const created = o.createdAt || o.dateAdded || '';
    return created.startsWith(today());
  });

  const metrics = computeSetterMetrics(todayOpps, stageMap);

  const row = {
    setter_name: name,
    location_id: locationId,
    date: today(),
    ...metrics,
  };

  await upsertSetterDaily(row);
  return row;
}

async function syncCloser() {
  const { tony } = CLOSER;
  const token = getToken(tony.paidAdsLocationId);
  const client = createGhlClient(token);
  const stageMap = await buildStageMap(client, tony.paidAdsLocationId);
  const pipelines = await client.getPipelines(tony.paidAdsLocationId);

  let allOpps = [];
  for (const pipeline of pipelines) {
    const opps = await client.getOpportunities(tony.paidAdsLocationId, pipeline.id);
    allOpps.push(...opps);
  }

  const todayOpps = allOpps.filter(o => {
    const created = o.createdAt || o.dateAdded || '';
    return created.startsWith(today());
  });

  const metrics = computeCloserMetrics(todayOpps, stageMap);

  const row = {
    date: today(),
    ...metrics,
  };

  await upsertCloserDaily(row);
  return row;
}

async function runSync() {
  console.log(`[tracker] sync started at ${new Date().toISOString()}`);

  const setterRows = [];
  for (const [name, { locationId }] of Object.entries(SETTERS)) {
    try {
      const row = await withTimeout(syncSetter(name, locationId), ACCOUNT_TIMEOUT_MS, name);
      setterRows.push(row);
      console.log(`[tracker] ${name}: ${row.closed_trial + row.closed_ppa} closes, ${row.close_rate}% rate`);
    } catch (err) {
      console.error(`[tracker] ${name} sync failed: ${err.message}`);
    }
  }

  let closerRow = null;
  try {
    closerRow = await withTimeout(syncCloser(), ACCOUNT_TIMEOUT_MS, 'tony');
    console.log(`[tracker] tony: ${closerRow.retainer_closes + closerRow.trial_closes} closes`);
  } catch (err) {
    console.error(`[tracker] tony sync failed: ${err.message}`);
  }

  const leadBank = computeLeadBankRunway(LEAD_BANK_TOTAL, DAILY_BURN);

  const snapshot = computeAgencySnapshot(setterRows, closerRow, [], [], [], leadBank);
  await upsertAgencyDaily(snapshot);
  console.log(`[tracker] agency snapshot: ${snapshot.total_closes} closes, $${snapshot.total_ppa_revenue} PPA, $${snapshot.total_retainer_mrr} MRR`);

  const alerts = checkAlerts({ ppaClients: [], setterRows, closerRow, leadBank });
  for (const alert of alerts) {
    await insertAlert(alert);
    console.log(`[tracker] ALERT [${alert.severity}]: ${alert.message}`);
  }

  console.log(`[tracker] sync complete. ${alerts.length} alerts.`);

  // Write to vault Pinnacle _index.md
  try {
    updateVaultPinnacle(snapshot, setterRows, closerRow);
  } catch (err) {
    console.error(`[tracker] vault write failed: ${err.message}`);
  }
}

if (require.main === module) {
  if (!acquireLock()) {
    console.log('[tracker] another sync is running — skipping');
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  const args = process.argv.slice(2);

  if (args.includes('--cron')) {
    const cron = require('node-cron');
    console.log('[tracker] starting cron — runs hourly at :00');
    cron.schedule('0 * * * *', () => {
      runSync().catch(err => console.error('[tracker] cron cycle failed:', err.message));
    });
    runSync().catch(err => console.error('[tracker] initial sync failed:', err.message));
  } else {
    runSync()
      .then(() => { releaseLock(); process.exit(0); })
      .catch(err => {
        console.error('[tracker] fatal:', err.message);
        releaseLock();
        process.exit(1);
      });
  }
}

module.exports = { runSync };
