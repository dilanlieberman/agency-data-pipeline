// Set env before any module loads
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-key';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      upsert: jest.fn().mockResolvedValue({ error: null }),
      insert: jest.fn().mockResolvedValue({ error: null }),
    })),
  })),
}));

jest.mock('../../scripts/agency-tracker/lib/ghl-client');
jest.mock('../../scripts/agency-tracker/lib/supabase-client', () => ({
  upsertSetterDaily: jest.fn().mockResolvedValue(),
  upsertCloserDaily: jest.fn().mockResolvedValue(),
  upsertPpaClientDaily: jest.fn().mockResolvedValue(),
  upsertRetainerClient: jest.fn().mockResolvedValue(),
  upsertBuilderPipeline: jest.fn().mockResolvedValue(),
  upsertAgencyDaily: jest.fn().mockResolvedValue(),
  insertAlert: jest.fn().mockResolvedValue(),
}));
jest.mock('../../scripts/agency-tracker/lib/config', () => {
  const actual = jest.requireActual('../../scripts/agency-tracker/lib/config');
  return {
    ...actual,
    getToken: jest.fn().mockReturnValue('test-token'),
  };
});

const { createGhlClient } = require('../../scripts/agency-tracker/lib/ghl-client');
const sb = require('../../scripts/agency-tracker/lib/supabase-client');

describe('tracker sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'test-key';

    const mockClient = {
      getContacts: jest.fn().mockResolvedValue([]),
      getContactsByTag: jest.fn().mockResolvedValue([]),
      getPipelines: jest.fn().mockResolvedValue([{ id: 'p1', name: 'Main', stages: [] }]),
      getOpportunities: jest.fn().mockResolvedValue([]),
      getCalendarEvents: jest.fn().mockResolvedValue([]),
    };
    createGhlClient.mockReturnValue(mockClient);

    sb.upsertSetterDaily.mockResolvedValue();
    sb.upsertCloserDaily.mockResolvedValue();
    sb.upsertAgencyDaily.mockResolvedValue();
    sb.insertAlert.mockResolvedValue();
  });

  test('runSync exports a function', () => {
    const { runSync } = require('../../scripts/agency-tracker/index');
    expect(typeof runSync).toBe('function');
  });

  test('runSync calls GHL for each setter account', async () => {
    const { runSync } = require('../../scripts/agency-tracker/index');
    await runSync();

    // 3 setters = 3 upsertSetterDaily calls
    expect(sb.upsertSetterDaily).toHaveBeenCalledTimes(3);
  });

  test('runSync writes agency snapshot', async () => {
    const { runSync } = require('../../scripts/agency-tracker/index');
    await runSync();

    expect(sb.upsertAgencyDaily).toHaveBeenCalledTimes(1);
  });
});
