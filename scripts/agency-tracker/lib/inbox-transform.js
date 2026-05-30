// scripts/agency-tracker/lib/inbox-transform.js
//
// Pure transforms for the Pinnacle Inbox sync. No I/O — unit-tested in
// tests/agency-tracker/inbox-transform.test.js.

function msgTime(m) {
  return m && m.dateAdded ? new Date(m.dateAdded).getTime() : 0;
}

// Newest message by dateAdded. Returns null for empty/missing input.
function pickNewestMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return messages.reduce((newest, m) => (msgTime(m) >= msgTime(newest) ? m : newest));
}

// "Needs my attention" = the lead spoke last (newest message is inbound).
function deriveNeedsReply(messages) {
  const newest = pickNewestMessage(messages);
  return !!newest && newest.direction === 'inbound';
}

function contactName(conv) {
  if (conv.fullName) return conv.fullName;
  if (conv.contactName) return conv.contactName;
  const joined = [conv.firstName, conv.lastName].filter(Boolean).join(' ');
  return joined || null;
}

// conv: GHL conversation object. messages: that conversation's messages.
// pulledAt: ISO string for updated_at (injectable for deterministic tests).
function buildConversationRow(conv, messages, pulledAt = new Date().toISOString()) {
  const newest = pickNewestMessage(messages);
  return {
    conv_id: conv.id,
    contact_id: conv.contactId || null,
    contact_name: contactName(conv),
    phone: conv.phone || null,
    email: conv.email || null,
    last_message_body: newest ? (newest.body ?? null) : null,
    last_message_at: newest ? (newest.dateAdded ?? null) : null,
    last_message_direction: newest ? (newest.direction ?? null) : null,
    needs_reply: deriveNeedsReply(messages),
    unread_in_ghl: conv.unreadCount ?? null,
    raw_json: conv,
    updated_at: pulledAt,
  };
}

function buildMessageRow(msg, convId) {
  return {
    msg_id: msg.id,
    conv_id: convId,
    body: msg.body ?? null,
    direction: msg.direction ?? null,
    message_type: msg.messageType || msg.type || null,
    created_at: msg.dateAdded ?? null,
    raw_json: msg,
  };
}

module.exports = { pickNewestMessage, deriveNeedsReply, buildConversationRow, buildMessageRow };
