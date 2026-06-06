// scripts/agency-tracker/ghl-inbox-sync.js
//
// Mirrors the Pinnacle GHL sub-account's conversations + full message bodies into
// Supabase (pinnacle_conversations + pinnacle_messages) for the read-only Inbox page.
//
// Modes:
//   (default) reconcile — re-pull recent threads, upsert, recompute needs_reply.
//   --backfill          — walk all conversations (more pages) for the initial load.
//   --conv <conv_id>    — sync exactly one conversation (used by the webhook).
//   --dry               — no Supabase writes; log what would happen.
//
// Spec: docs/superpowers/specs/2026-05-28-pinnacle-inbox-design.md
// Cron: every 15 min (reconcile). Webhook: instant single-conversation.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { createGhlClient } = require('./lib/ghl-client');
const { PINNACLE_LOCATION_ID } = require('./lib/pinnacle-paid-ads-stages');
const { buildConversationRow, buildMessageRow } = require('./lib/inbox-transform');

const TOKEN = process.env.GHL_PINNACLE_PRIVATE_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function makeClients() {
  if (!TOKEN) throw new Error('GHL_PINNACLE_PRIVATE_TOKEN missing from .env');
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
  return { ghl: createGhlClient(TOKEN), supabase: createClient(SUPABASE_URL, SUPABASE_KEY) };
}

// Upsert one conversation + all its messages. Returns the conversation row.
async function upsertConversation(supabase, conv, messages, { dry = false } = {}) {
  const convRow = buildConversationRow(conv, messages);
  const msgRows = messages.map((m) => buildMessageRow(m, conv.id));

  if (dry) {
    console.log(`[dry] conv=${conv.id} needs_reply=${convRow.needs_reply} msgs=${msgRows.length}`);
    return convRow;
  }

  // Conversation first (messages FK it), then messages.
  const { error: cErr } = await supabase
    .from('pinnacle_conversations')
    .upsert(convRow, { onConflict: 'conv_id' });
  if (cErr) console.log(`[supabase-conv-error] ${conv.id}: ${cErr.message}`);

  if (msgRows.length) {
    const { error: mErr } = await supabase
      .from('pinnacle_messages')
      .upsert(msgRows, { onConflict: 'msg_id' });
    if (mErr) console.log(`[supabase-msg-error] ${conv.id}: ${mErr.message}`);
  }
  return convRow;
}

// Sync exactly one conversation by id. Used by the webhook for instant surfacing.
async function syncOneConversation(convId, deps) {
  const { ghl, supabase } = deps || makeClients();
  // The webhook gives us a conv id but not the conversation object; fetch its
  // messages and synthesize a minimal conv record. searchConversations is the
  // source of richer identity fields during the reconcile pass.
  const messages = await ghl.getMessages(convId, { maxPages: 5, limit: 100 });
  const conv = { id: convId, contactId: messages[0]?.contactId || null };
  return upsertConversation(supabase, conv, messages, {});
}

// Full reconcile / backfill pass over the Pinnacle location.
async function runSync({ backfill = false, dry = false } = {}) {
  const { ghl, supabase } = makeClients();
  const maxPages = backfill ? 40 : 8;
  console.log(`ghl-inbox-sync ${backfill ? '[backfill]' : '[reconcile]'} ${dry ? '[dry]' : ''} loc=${PINNACLE_LOCATION_ID}`);

  const convs = await ghl.searchConversations(PINNACLE_LOCATION_ID, { maxPages, limit: 25 });
  console.log(`  ${convs.length} conversations`);

  let synced = 0;
  for (const conv of convs) {
    let messages;
    try {
      messages = await ghl.getMessages(conv.id, { maxPages: 5, limit: 100 });
    } catch (err) {
      console.log(`  [warn] conv=${conv.id} ${err.response?.status || err.code || err.message}`);
      continue;
    }
    await upsertConversation(supabase, conv, messages, { dry });
    synced++;
  }
  console.log(`done. synced=${synced}`);
  return synced;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const backfill = args.includes('--backfill');
  const convIdx = args.indexOf('--conv');
  if (convIdx >= 0) {
    const convId = args[convIdx + 1];
    if (!convId) { console.error('--conv requires a conversation id'); process.exit(2); }
    await syncOneConversation(convId);
  } else {
    await runSync({ backfill, dry });
  }
}

module.exports = { upsertConversation, syncOneConversation, runSync };

// Only run when invoked directly (so the webhook can require this module).
if (require.main === module) {
  main().catch((e) => { console.error('fatal:', e); process.exit(1); });
}
