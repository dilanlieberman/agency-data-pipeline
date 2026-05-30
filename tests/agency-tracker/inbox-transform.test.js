// tests/agency-tracker/inbox-transform.test.js
const {
  pickNewestMessage,
  deriveNeedsReply,
  buildConversationRow,
  buildMessageRow,
} = require('../../scripts/agency-tracker/lib/inbox-transform');

const MSGS = [
  { id: 'm1', body: 'Hi, saw your ad', direction: 'inbound',  dateAdded: '2026-05-28T10:00:00Z', messageType: 'SMS' },
  { id: 'm2', body: 'Thanks for reaching out!', direction: 'outbound', dateAdded: '2026-05-28T10:05:00Z', type: 'SMS' },
  { id: 'm3', body: 'What time can you do?', direction: 'inbound', dateAdded: '2026-05-28T10:20:00Z', messageType: 'SMS' },
];

describe('pickNewestMessage', () => {
  test('returns the message with the latest dateAdded regardless of input order', () => {
    expect(pickNewestMessage(MSGS).id).toBe('m3');
  });
  test('returns null for empty input', () => {
    expect(pickNewestMessage([])).toBeNull();
    expect(pickNewestMessage(null)).toBeNull();
  });
});

describe('deriveNeedsReply', () => {
  test('true when newest message is inbound', () => {
    expect(deriveNeedsReply(MSGS)).toBe(true);
  });
  test('false when newest message is outbound', () => {
    const replied = [...MSGS, { id: 'm4', body: 'How about 3pm?', direction: 'outbound', dateAdded: '2026-05-28T10:30:00Z', type: 'SMS' }];
    expect(deriveNeedsReply(replied)).toBe(false);
  });
  test('false for an empty thread', () => {
    expect(deriveNeedsReply([])).toBe(false);
  });
});

describe('buildConversationRow', () => {
  const conv = {
    id: 'c1', contactId: 'ct1', fullName: 'Jane Roofer',
    phone: '+15551234567', email: 'jane@example.com', unreadCount: 2,
  };
  const row = buildConversationRow(conv, MSGS, '2026-05-28T11:00:00Z');

  test('maps identity + newest-message fields', () => {
    expect(row.conv_id).toBe('c1');
    expect(row.contact_id).toBe('ct1');
    expect(row.contact_name).toBe('Jane Roofer');
    expect(row.phone).toBe('+15551234567');
    expect(row.email).toBe('jane@example.com');
    expect(row.last_message_body).toBe('What time can you do?');
    expect(row.last_message_at).toBe('2026-05-28T10:20:00Z');
    expect(row.last_message_direction).toBe('inbound');
    expect(row.needs_reply).toBe(true);
    expect(row.unread_in_ghl).toBe(2);
    expect(row.updated_at).toBe('2026-05-28T11:00:00Z');
    expect(row.raw_json).toBe(conv);
  });

  test('falls back to firstName+lastName when fullName is absent', () => {
    const r = buildConversationRow({ id: 'c2', firstName: 'Bob', lastName: 'Smith' }, MSGS, '2026-05-28T11:00:00Z');
    expect(r.contact_name).toBe('Bob Smith');
  });
});

describe('buildMessageRow', () => {
  test('maps a message into a row, preferring messageType over type', () => {
    const r = buildMessageRow(MSGS[0], 'c1');
    expect(r).toEqual({
      msg_id: 'm1', conv_id: 'c1', body: 'Hi, saw your ad',
      direction: 'inbound', message_type: 'SMS',
      created_at: '2026-05-28T10:00:00Z', raw_json: MSGS[0],
    });
  });
  test('uses type when messageType is absent', () => {
    expect(buildMessageRow(MSGS[1], 'c1').message_type).toBe('SMS');
  });
});
