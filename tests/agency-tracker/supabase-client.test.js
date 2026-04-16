// tests/agency-tracker/supabase-client.test.js

// Mock setup must come before require so createClient() can reference mockFrom
const mockUpsert = jest.fn().mockResolvedValue({ error: null });
const mockInsert = jest.fn().mockResolvedValue({ error: null });
const mockFrom = jest.fn(() => ({
  upsert: mockUpsert,
  insert: mockInsert,
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: mockFrom,
  })),
}));

const {
  supabase,
  upsert,
  upsertSetterDaily,
  upsertCloserDaily,
  upsertPpaClientDaily,
  upsertRetainerClient,
  upsertBuilderPipeline,
  upsertAgencyDaily,
  insertAlert,
} = require('../../scripts/agency-tracker/lib/supabase-client');

describe('supabase-client', () => {
  beforeAll(() => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('exports', () => {
    test('supabase client instance is exported', () => {
      expect(supabase).toBeDefined();
      expect(typeof supabase).toBe('object');
    });

    test('upsert function is exported', () => {
      expect(typeof upsert).toBe('function');
    });

    test('upsertSetterDaily is exported as a function', () => {
      expect(typeof upsertSetterDaily).toBe('function');
    });

    test('upsertCloserDaily is exported as a function', () => {
      expect(typeof upsertCloserDaily).toBe('function');
    });

    test('upsertPpaClientDaily is exported as a function', () => {
      expect(typeof upsertPpaClientDaily).toBe('function');
    });

    test('upsertRetainerClient is exported as a function', () => {
      expect(typeof upsertRetainerClient).toBe('function');
    });

    test('upsertBuilderPipeline is exported as a function', () => {
      expect(typeof upsertBuilderPipeline).toBe('function');
    });

    test('upsertAgencyDaily is exported as a function', () => {
      expect(typeof upsertAgencyDaily).toBe('function');
    });

    test('insertAlert is exported as a function', () => {
      expect(typeof insertAlert).toBe('function');
    });
  });

  describe('upsert', () => {
    test('calls supabase.from(table).upsert() with correct onConflict', async () => {
      const testData = { id: 1, name: 'Test' };
      const onConflict = 'setter_name,date';

      await upsert('test_table', testData, onConflict);

      expect(mockFrom).toHaveBeenCalledWith('test_table');
      expect(mockUpsert).toHaveBeenCalledWith(testData, { onConflict });
    });

    test('throws an error when Supabase returns error', async () => {
      const testError = { message: 'Database error' };
      mockUpsert.mockResolvedValueOnce({ error: testError });

      await expect(upsert('test_table', {}, 'id')).rejects.toThrow('Database error');
    });

    test('returns data on successful upsert', async () => {
      const testData = { id: 1, name: 'Test' };
      mockUpsert.mockResolvedValueOnce({ error: null, data: testData });

      const result = await upsert('test_table', testData, 'id');

      expect(result).toEqual(testData);
    });
  });

  describe('upsertSetterDaily', () => {
    test('calls upsert with correct table and onConflict', async () => {
      const row = { setter_name: 'John', date: '2026-04-15', value: 100 };

      await upsertSetterDaily(row);

      expect(mockFrom).toHaveBeenCalledWith('setter_daily');
      expect(mockUpsert).toHaveBeenCalledWith(row, { onConflict: 'setter_name,date' });
    });
  });

  describe('upsertCloserDaily', () => {
    test('calls upsert with correct table and onConflict', async () => {
      const row = { date: '2026-04-15', value: 50 };

      await upsertCloserDaily(row);

      expect(mockFrom).toHaveBeenCalledWith('closer_daily');
      expect(mockUpsert).toHaveBeenCalledWith(row, { onConflict: 'date' });
    });
  });

  describe('upsertPpaClientDaily', () => {
    test('calls upsert with correct table and onConflict', async () => {
      const row = { client_name: 'Client A', date: '2026-04-15', value: 200 };

      await upsertPpaClientDaily(row);

      expect(mockFrom).toHaveBeenCalledWith('ppa_client_daily');
      expect(mockUpsert).toHaveBeenCalledWith(row, { onConflict: 'client_name,date' });
    });
  });

  describe('upsertRetainerClient', () => {
    test('calls upsert with correct table and onConflict', async () => {
      const row = { client_name: 'Retainer Client', value: 300 };

      await upsertRetainerClient(row);

      expect(mockFrom).toHaveBeenCalledWith('retainer_client');
      expect(mockUpsert).toHaveBeenCalledWith(row, { onConflict: 'client_name' });
    });
  });

  describe('upsertBuilderPipeline', () => {
    test('calls upsert with correct table and onConflict', async () => {
      const row = { builder_name: 'Builder A', value: 400 };

      await upsertBuilderPipeline(row);

      expect(mockFrom).toHaveBeenCalledWith('builder_pipeline');
      expect(mockUpsert).toHaveBeenCalledWith(row, { onConflict: 'builder_name' });
    });
  });

  describe('upsertAgencyDaily', () => {
    test('calls upsert with correct table and onConflict', async () => {
      const row = { date: '2026-04-15', value: 500 };

      await upsertAgencyDaily(row);

      expect(mockFrom).toHaveBeenCalledWith('agency_daily');
      expect(mockUpsert).toHaveBeenCalledWith(row, { onConflict: 'date' });
    });
  });

  describe('insertAlert', () => {
    test('calls supabase.from(alerts).insert()', async () => {
      const row = { message: 'Test alert', severity: 'high' };

      await insertAlert(row);

      expect(mockFrom).toHaveBeenCalledWith('alerts');
      expect(mockInsert).toHaveBeenCalledWith(row);
    });

    test('throws an error when Supabase returns error', async () => {
      const testError = { message: 'Insert error' };
      mockInsert.mockResolvedValueOnce({ error: testError });

      await expect(insertAlert({})).rejects.toThrow('Insert error');
    });

    test('returns data on successful insert', async () => {
      const row = { message: 'Test alert' };
      mockInsert.mockResolvedValueOnce({ error: null, data: row });

      const result = await insertAlert(row);

      expect(result).toEqual(row);
    });
  });
});
