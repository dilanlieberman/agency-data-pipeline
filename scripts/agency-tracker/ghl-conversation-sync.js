// Per-setter, per-day GHL conversation/message-level metrics.
// Powers Layer 3 of the Pinnacle Performance Tracker.
//
// Iterates each setter's location IDs, pulls recent conversations + messages,
// counts outbound/inbound activity for the EDT day, upserts conversation_metrics_daily.
//
// Run: node scripts/agency-tracker/ghl-conversation-sync.js [--dry] [--date YYYY-MM-DD] [--setter <name>]
// Cron: every 30 min (mirrors the agency-tracker cadence).

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { createGhlClient } = require('./lib/ghl-client');
const { SETTERS } = require('./lib/config');

const TOKEN_MAP_PATH = path.join(__dirname, '../../data/sub-account-tokens.json');
const TOKEN_MAP = JSON.parse(fs.readFileSync(TOKEN_MAP_PATH, 'utf8'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ONLY_SETTER = (() => {
  const i = args.indexOf('--setter');
  return i >= 0 ? args[i + 1] : null;
})();
const TARGET_DATE = (() => {
  const i = args.indexOf('--date');
  return i >= 0 ? args[i + 1] : null;
})();

// EDT day window. If TARGET_DATE provided (YYYY-MM-DD), use that EDT calendar day.
// Otherwise use today.
function edtDayBounds(yyyymmdd) {
  const dateStr = yyyymmdd || formatEdtDate(new Date());
  const start = new Date(`${dateStr}T00:00:00-04:00`);  // EDT (UTC-4)
  const end = new Date(`${dateStr}T23:59:59.999-04:00`);
  return { dateStr, startMs: start.getTime(), endMs: end.getTime() };
}

function formatEdtDate(d) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);  // YYYY-MM-DD
}

const POSITIVE_RE = /\b(yes|yeah|sure|interested|tell me more|how|when|where|how much|what time|sounds good|sounds great|let'?s|chat|call me|i'?d like|would like|please|appointment|schedule|available|info|estimate|quote)\b/i;
const NEGATIVE_RE = /\b(stop|unsubscribe|remove me|wrong (number|person)|not interested|no thanks|how did you get|do not text|don'?t (text|contact))\b/i;

function classifyReply(body) {
  if (!body) return 'empty';
  const t = body.trim();
  if (t.length < 4) return 'empty';
  if (NEGATIVE_RE.test(t)) return 'negative';
  if (POSITIVE_RE.test(t)) return 'positive';
  return 'neutral';
}

function msToIso(ms) {
  return new Date(ms).toISOString();
}

async function syncOneLocation(setterName, locationId) {
  const tokenEntry = TOKEN_MAP[locationId];
  if (!tokenEntry) {
    console.log(`[skip] ${setterName}/${locationId} — no token in sub-account-tokens.json`);
    return null;
  }
  const ghl = createGhlClient(tokenEntry.token);
  const { dateStr, startMs, endMs } = edtDayBounds(TARGET_DATE);

  // Pull conversations updated recently. Stop paginating once lastMessageDate
  // falls before our window.
  const convs = await ghl.searchConversations(locationId, { maxPages: 8, limit: 25 });
  const inWindow = [];
  for (const c of convs) {
    const lastMs = c.lastMessageDate ? new Date(c.lastMessageDate).getTime() : 0;
    if (lastMs < startMs - 7 * 24 * 60 * 60 * 1000) break;  // 7-day grace for cursor jitter
    inWindow.push(c);
  }

  const counters = {
    msgs_sent: 0,
    msgs_received: 0,
    unique_contacts_messaged: new Set(),
    replies_received: 0,
    positive_replies: 0,
    negative_replies: 0,
    response_times_minutes: [],
  };

  for (const conv of inWindow) {
    let msgs;
    try {
      msgs = await ghl.getMessages(conv.id, { maxPages: 3, limit: 100 });
    } catch (err) {
      console.log(`  [warn] ${setterName}/${locationId} conv=${conv.id} ${err.response?.status || err.code || err.message}`);
      continue;
    }

    // Sort oldest-first for response-time calc.
    msgs.sort((a, b) => new Date(a.dateAdded || 0) - new Date(b.dateAdded || 0));

    let lastOutboundMs = null;
    for (const m of msgs) {
      const ms = m.dateAdded ? new Date(m.dateAdded).getTime() : 0;
      if (ms < startMs || ms > endMs) continue;
      // Only count SMS-style messages (skip emails, notes, voicemails)
      const t = m.messageType || m.type;
      const isSms = t === 'SMS' || t === 'TYPE_SMS' || t === 1;
      if (!isSms) continue;

      if (m.direction === 'outbound') {
        counters.msgs_sent++;
        if (conv.contactId) counters.unique_contacts_messaged.add(conv.contactId);
        lastOutboundMs = ms;
      } else if (m.direction === 'inbound') {
        counters.msgs_received++;
        counters.replies_received++;
        const verdict = classifyReply(m.body);
        if (verdict === 'positive') counters.positive_replies++;
        else if (verdict === 'negative') counters.negative_replies++;
        if (lastOutboundMs && ms > lastOutboundMs) {
          const minutes = (ms - lastOutboundMs) / 60_000;
          if (minutes < 60 * 24 * 7) counters.response_times_minutes.push(minutes);
        }
      }
    }
  }

  const median = counters.response_times_minutes.length
    ? counters.response_times_minutes.sort((a, b) => a - b)[Math.floor(counters.response_times_minutes.length / 2)]
    : null;

  // appts_booked is left to the existing setter_daily sync (calls_booked) —
  // /calendars/events 422s without a calendarId, and the existing pipeline-
  // stage count is the operator's authoritative number.

  const row = {
    date: dateStr,
    setter_name: setterName,
    location_id: locationId,
    msgs_sent: counters.msgs_sent,
    msgs_received: counters.msgs_received,
    unique_contacts_messaged: counters.unique_contacts_messaged.size,
    replies_received: counters.replies_received,
    positive_replies: counters.positive_replies,
    appts_booked: 0,  // see setter_daily.calls_booked instead
    median_response_minutes: median,
    pulled_at: new Date().toISOString(),
  };

  console.log(
    `  ${setterName}/${locationId} ${dateStr}: sent=${row.msgs_sent} replies=${row.replies_received} pos=${row.positive_replies} median=${median != null ? median.toFixed(1) + 'm' : 'n/a'}`
  );

  if (!DRY) {
    const { error } = await supabase
      .from('conversation_metrics_daily')
      .upsert(row, { onConflict: 'date,setter_name,location_id' });
    if (error) console.log(`  [supabase-upsert-error] ${error.message}`);
  }
  return row;
}

async function main() {
  const setters = ONLY_SETTER ? { [ONLY_SETTER]: SETTERS[ONLY_SETTER] } : SETTERS;
  if (ONLY_SETTER && !setters[ONLY_SETTER]) {
    console.error(`unknown setter: ${ONLY_SETTER}. Known: ${Object.keys(SETTERS).join(', ')}`);
    process.exit(2);
  }

  console.log(`ghl-conversation-sync ${TARGET_DATE ? `(date=${TARGET_DATE})` : ''} ${DRY ? '[DRY]' : ''}`);
  for (const [setterName, cfg] of Object.entries(setters)) {
    const locs = Array.isArray(cfg)
      ? cfg
      : cfg.locationIds || (cfg.locationId ? [cfg.locationId] : []);
    if (!locs.length) {
      console.log(`[skip] ${setterName} — no location IDs in config`);
      continue;
    }
    console.log(`[setter] ${setterName} (${locs.length} locations)`);
    for (const locId of locs) {
      try {
        await syncOneLocation(setterName, locId);
      } catch (err) {
        console.error(`  [error] ${setterName}/${locId}: ${err.response?.status || ''} ${err.message}`);
      }
    }
  }
  console.log('done.');
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
