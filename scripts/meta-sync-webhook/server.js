// scripts/meta-sync-webhook/server.js
//
// Tiny HTTP webhook that triggers a flocked run of meta-ad-sync.js.
// The Pinnacle Lovable ad dashboard POSTs here on page-mount + refresh-click,
// so the dashboard always shows fresh data without burning CPU 24/7. Background
// hourly cron is the floor; this endpoint is the on-demand trigger.
//
// Env (set via `pm2 set meta-sync-webhook:KEY value`):
//   PORT                       default 3010
//   META_SYNC_API_KEY          required — shared secret in X-API-Key header
//   META_SYNC_CORS_ORIGIN      default '*' — set to Lovable origin in prod
//
// Auth: X-API-Key header constant-time-compared against META_SYNC_API_KEY.
// Spawns flock -n /tmp/meta-ad-sync.lock <node> meta-ad-sync.js detached;
// returns 202 immediately. If the lock is held, flock exits silently — the
// caller still gets 202 because the realtime Supabase subscription doesn't
// care whether this trigger ran a fresh sync or piggybacked on an in-flight one.

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3010', 10);
const API_KEY = process.env.META_SYNC_API_KEY;
const CORS_ORIGIN = process.env.META_SYNC_CORS_ORIGIN || '*';
const META_AD_SYNC_PATH = path.resolve(__dirname, '../agency-tracker/meta-ad-sync.js');
const LOCK_PATH = '/tmp/meta-ad-sync.lock';

if (!API_KEY) {
  console.error('META_SYNC_API_KEY env var is required — refusing to start');
  process.exit(1);
}

const apiKeyBuf = Buffer.from(API_KEY);

function checkKey(given) {
  if (typeof given !== 'string') return false;
  const buf = Buffer.from(given);
  // Length mismatch fails before timingSafeEqual would throw
  if (buf.length !== apiKeyBuf.length) return false;
  return crypto.timingSafeEqual(buf, apiKeyBuf);
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Public health check — Caddy + uptime monitoring can hit this without a key
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/meta-sync/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'meta-sync-webhook' }));
  }

  const isSyncRoute = req.method === 'POST'
    && (req.url === '/sync-meta-ads' || req.url === '/meta-sync/sync-meta-ads');

  if (!isSyncRoute) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }

  if (!checkKey(req.headers['x-api-key'])) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }

  const child = spawn(
    '/usr/bin/flock',
    ['-n', LOCK_PATH, '/usr/bin/node', META_AD_SYNC_PATH],
    { detached: true, stdio: 'ignore' }
  );
  child.on('error', (err) => console.error('spawn error:', err));
  child.unref();

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, triggered: true }));
});

server.listen(PORT, () => {
  console.log(`meta-sync-webhook listening on :${PORT}`);
});
