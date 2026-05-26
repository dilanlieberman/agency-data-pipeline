// Tests for shared Meta helpers extracted to lib/meta-helpers.js.
//
// Covers: stripClient, sumActions, maxAction, LEAD_ACTION_TYPES.
// graph() and listActiveAccounts() / listAllAccounts() are async + hit
// the network — tested indirectly via the consuming scripts.

beforeAll(() => {
  process.env.META_ACCESS_TOKEN = 'test_token';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
});

const {
  stripClient,
  sumActions,
  maxAction,
  LEAD_ACTION_TYPES,
} = require('../../scripts/agency-tracker/lib/meta-helpers');

// ─── LEAD_ACTION_TYPES ──────────────────────────────────────────────────────

describe('LEAD_ACTION_TYPES', () => {
  test('is an array with the 4 canonical lead action types', () => {
    expect(Array.isArray(LEAD_ACTION_TYPES)).toBe(true);
    expect(LEAD_ACTION_TYPES).toEqual([
      'lead',
      'offsite_conversion.fb_pixel_lead',
      'onsite_conversion.lead_grouped',
      'onsite_conversion.lead',
    ]);
  });
});

// ─── stripClient ─────────────────────────────────────────────────────────────

describe('stripClient', () => {
  test('strips "x Pinnacle" suffix', () => {
    expect(stripClient('Greenstone x Pinnacle')).toBe('Greenstone');
  });

  test('strips "X Pinnacle" (capital X)', () => {
    expect(stripClient('C&M X Pinnacle')).toBe('C&M');
  });

  test('strips "@Pinnacle" suffix', () => {
    expect(stripClient('OneCall@Pinnacle')).toBe('OneCall');
  });

  test('strips "@pinnacle" (lowercase)', () => {
    expect(stripClient('Test@pinnacle')).toBe('Test');
  });

  test('strips standalone "Pinnacle"', () => {
    expect(stripClient('Pinnacle')).toBe('');
  });

  test('strips "xPinnacle" (no space)', () => {
    expect(stripClient('GreenStonexPinnacle')).toBe('GreenStone');
  });

  test('handles name with no Pinnacle reference', () => {
    expect(stripClient('Some Random Ad Account')).toBe('Some Random Ad Account');
  });

  test('trims trailing whitespace and special chars', () => {
    expect(stripClient('Greenstone x Pinnacle   ')).toBe('Greenstone');
  });

  test('handles "x Pinacle" (one n — typo variant)', () => {
    // The regex uses Pinn?acle to handle single-n typos
    expect(stripClient('Test x Pinacle')).toBe('Test');
  });
});

// ─── sumActions ──────────────────────────────────────────────────────────────

describe('sumActions', () => {
  test('sums values for matching action types in a Set', () => {
    const actions = [
      { action_type: 'lead', value: '3' },
      { action_type: 'landing_page_view', value: '10' },
      { action_type: 'lead', value: '2' },
    ];
    expect(sumActions(actions, new Set(['lead']))).toBe(5);
  });

  test('returns 0 for no matches', () => {
    const actions = [
      { action_type: 'link_click', value: '5' },
    ];
    expect(sumActions(actions, new Set(['lead']))).toBe(0);
  });

  test('returns 0 for null/undefined actions', () => {
    expect(sumActions(null, new Set(['lead']))).toBe(0);
    expect(sumActions(undefined, new Set(['lead']))).toBe(0);
  });

  test('returns 0 for empty actions array', () => {
    expect(sumActions([], new Set(['lead']))).toBe(0);
  });

  test('handles missing value field gracefully', () => {
    const actions = [
      { action_type: 'lead' },
      { action_type: 'lead', value: '4' },
    ];
    expect(sumActions(actions, new Set(['lead']))).toBe(4);
  });

  test('sums across multiple matching types', () => {
    const actions = [
      { action_type: 'landing_page_view', value: '10' },
      { action_type: 'omni_landing_page_view', value: '5' },
    ];
    const types = new Set(['landing_page_view', 'omni_landing_page_view']);
    expect(sumActions(actions, types)).toBe(15);
  });
});

// ─── maxAction ───────────────────────────────────────────────────────────────

describe('maxAction', () => {
  test('returns max value across matching lead action types', () => {
    const actions = [
      { action_type: 'lead', value: '3' },
      { action_type: 'onsite_conversion.lead_grouped', value: '5' },
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '2' },
    ];
    expect(maxAction(actions, LEAD_ACTION_TYPES)).toBe(5);
  });

  test('returns 0 when no matching types', () => {
    const actions = [
      { action_type: 'link_click', value: '10' },
    ];
    expect(maxAction(actions, LEAD_ACTION_TYPES)).toBe(0);
  });

  test('returns 0 for null/undefined actions', () => {
    expect(maxAction(null, LEAD_ACTION_TYPES)).toBe(0);
    expect(maxAction(undefined, LEAD_ACTION_TYPES)).toBe(0);
  });

  test('returns 0 for empty actions array', () => {
    expect(maxAction([], LEAD_ACTION_TYPES)).toBe(0);
  });

  test('handles single matching action', () => {
    const actions = [
      { action_type: 'lead', value: '7' },
    ];
    expect(maxAction(actions, LEAD_ACTION_TYPES)).toBe(7);
  });

  test('handles missing value field', () => {
    const actions = [
      { action_type: 'lead' },
      { action_type: 'onsite_conversion.lead', value: '4' },
    ];
    expect(maxAction(actions, LEAD_ACTION_TYPES)).toBe(4);
  });
});
