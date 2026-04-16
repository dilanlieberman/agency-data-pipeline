'use strict';

const axios = require('axios');

// Mock axios at the module level
jest.mock('axios');

// Mock sleep so tests run fast (no real delays)
jest.mock('../../scripts/agency-tracker/lib/ghl-client', () => {
  // We need to override the sleep inside ghl-client before it runs.
  // Strategy: require the real module but patch sleep via jest.spyOn after mock.
  // Actually, easier: we load the real module after injecting the mock.
  const actual = jest.requireActual('../../scripts/agency-tracker/lib/ghl-client');
  return actual;
});

// Re-require the actual module (the jest.mock above is a no-op pass-through;
// we just need axios mocked, which was done above)
const { createGhlClient } = require('../../scripts/agency-tracker/lib/ghl-client');

const TOKEN = 'test-token-abc';
const LOCATION_ID = 'loc_123';

// Helper: build a successful axios response
function okResponse(data) {
  return Promise.resolve({ data, status: 200 });
}

// Helper: build a failed axios error
function axiosError(status, code) {
  const err = new Error(`Request failed with status ${status || code}`);
  if (status) {
    err.response = { status, data: { message: 'error' } };
  } else {
    err.code = code;
  }
  return Promise.reject(err);
}

describe('createGhlClient', () => {
  let client;

  beforeEach(() => {
    jest.clearAllMocks();
    client = createGhlClient(TOKEN);
  });

  // ─── Auth headers ────────────────────────────────────────────────────────────

  describe('auth headers', () => {
    it('sends correct Authorization header', async () => {
      axios.get.mockResolvedValueOnce({ data: { contacts: [] }, status: 200 });
      await client.getContacts(LOCATION_ID);
      const callConfig = axios.get.mock.calls[0][1];
      expect(callConfig.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    });

    it('sends Version header', async () => {
      axios.get.mockResolvedValueOnce({ data: { contacts: [] }, status: 200 });
      await client.getContacts(LOCATION_ID);
      const callConfig = axios.get.mock.calls[0][1];
      expect(callConfig.headers['Version']).toBeDefined();
    });

    it('sends Content-Type: application/json', async () => {
      axios.get.mockResolvedValueOnce({ data: { contacts: [] }, status: 200 });
      await client.getContacts(LOCATION_ID);
      const callConfig = axios.get.mock.calls[0][1];
      expect(callConfig.headers['Content-Type']).toBe('application/json');
    });

    it('sends Accept: application/json', async () => {
      axios.get.mockResolvedValueOnce({ data: { contacts: [] }, status: 200 });
      await client.getContacts(LOCATION_ID);
      const callConfig = axios.get.mock.calls[0][1];
      expect(callConfig.headers['Accept']).toBe('application/json');
    });
  });

  // ─── getContacts ─────────────────────────────────────────────────────────────

  describe('getContacts', () => {
    it('includes locationId in params', async () => {
      axios.get.mockResolvedValueOnce({ data: { contacts: [] }, status: 200 });
      await client.getContacts(LOCATION_ID);
      const callParams = axios.get.mock.calls[0][1].params;
      expect(callParams.locationId).toBe(LOCATION_ID);
    });

    it('returns empty array when no contacts', async () => {
      axios.get.mockResolvedValueOnce({ data: { contacts: [] }, status: 200 });
      const result = await client.getContacts(LOCATION_ID);
      expect(result).toEqual([]);
    });

    it('paginates through all contacts (2 pages)', async () => {
      // Page 1: full PAGE_SIZE (20) contacts
      const page1 = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, name: `Contact ${i}` }));
      // Page 2: partial page (5) contacts — signals end of results
      const page2 = Array.from({ length: 5 }, (_, i) => ({ id: `c${20 + i}`, name: `Contact ${20 + i}` }));

      axios.get
        .mockResolvedValueOnce({ data: { contacts: page1 }, status: 200 })
        .mockResolvedValueOnce({ data: { contacts: page2 }, status: 200 });

      const result = await client.getContacts(LOCATION_ID);
      expect(result).toHaveLength(25);
      expect(result[0].id).toBe('c0');
      expect(result[24].id).toBe('c24');
    });

    it('makes correct skip offset on second page', async () => {
      const page1 = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}` }));
      const page2 = [];

      axios.get
        .mockResolvedValueOnce({ data: { contacts: page1 }, status: 200 })
        .mockResolvedValueOnce({ data: { contacts: page2 }, status: 200 });

      await client.getContacts(LOCATION_ID);
      const secondCallParams = axios.get.mock.calls[1][1].params;
      expect(secondCallParams.skip).toBe(20);
    });

    it('passes query params through', async () => {
      axios.get.mockResolvedValueOnce({ data: { contacts: [] }, status: 200 });
      await client.getContacts(LOCATION_ID, { query: 'john' });
      const callParams = axios.get.mock.calls[0][1].params;
      expect(callParams.query).toBe('john');
    });
  });

  // ─── getContactsByTag ─────────────────────────────────────────────────────────

  describe('getContactsByTag', () => {
    it('includes tag in params', async () => {
      axios.get.mockResolvedValueOnce({ data: { contacts: [] }, status: 200 });
      await client.getContactsByTag(LOCATION_ID, 'qualified_appt');
      const callParams = axios.get.mock.calls[0][1].params;
      expect(callParams.tags).toBe('qualified_appt');
    });

    it('includes locationId in params', async () => {
      axios.get.mockResolvedValueOnce({ data: { contacts: [] }, status: 200 });
      await client.getContactsByTag(LOCATION_ID, 'some_tag');
      const callParams = axios.get.mock.calls[0][1].params;
      expect(callParams.locationId).toBe(LOCATION_ID);
    });
  });

  // ─── getPipelines ─────────────────────────────────────────────────────────────

  describe('getPipelines', () => {
    it('returns pipelines for a location', async () => {
      const pipelines = [{ id: 'pip1', name: 'Main Pipeline' }, { id: 'pip2', name: 'Builder' }];
      axios.get.mockResolvedValueOnce({ data: { pipelines }, status: 200 });

      const result = await client.getPipelines(LOCATION_ID);
      expect(result).toEqual(pipelines);
    });

    it('calls the correct endpoint', async () => {
      axios.get.mockResolvedValueOnce({ data: { pipelines: [] }, status: 200 });
      await client.getPipelines(LOCATION_ID);
      const url = axios.get.mock.calls[0][0];
      expect(url).toContain('/opportunities/pipelines');
    });

    it('includes locationId in params', async () => {
      axios.get.mockResolvedValueOnce({ data: { pipelines: [] }, status: 200 });
      await client.getPipelines(LOCATION_ID);
      const callParams = axios.get.mock.calls[0][1].params;
      expect(callParams.locationId).toBe(LOCATION_ID);
    });
  });

  // ─── getOpportunities ────────────────────────────────────────────────────────

  describe('getOpportunities', () => {
    it('fetches opportunities for a pipeline', async () => {
      const opps = [{ id: 'opp1' }, { id: 'opp2' }];
      axios.get.mockResolvedValueOnce({ data: { opportunities: opps }, status: 200 });

      const result = await client.getOpportunities(LOCATION_ID, 'pip1');
      expect(result).toEqual(opps);
    });

    it('includes pipeline_id in params', async () => {
      axios.get.mockResolvedValueOnce({ data: { opportunities: [] }, status: 200 });
      await client.getOpportunities(LOCATION_ID, 'pip_abc');
      const callParams = axios.get.mock.calls[0][1].params;
      expect(callParams.pipeline_id).toBe('pip_abc');
    });

    it('includes locationId in params', async () => {
      axios.get.mockResolvedValueOnce({ data: { opportunities: [] }, status: 200 });
      await client.getOpportunities(LOCATION_ID, 'pip1');
      const callParams = axios.get.mock.calls[0][1].params;
      expect(callParams.location_id).toBe(LOCATION_ID);
    });
  });

  // ─── Retry logic ─────────────────────────────────────────────────────────────

  describe('retry on 429', () => {
    it('retries after a 429 and succeeds', async () => {
      axios.get
        .mockRejectedValueOnce((() => {
          const e = new Error('Too Many Requests');
          e.response = { status: 429, data: {} };
          return e;
        })())
        .mockResolvedValueOnce({ data: { contacts: [] }, status: 200 });

      const result = await client.getContacts(LOCATION_ID);
      expect(result).toEqual([]);
      // axios.get should have been called twice (once failed 429, once succeeded)
      expect(axios.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry on 5xx', () => {
    it('retries after a 500 and succeeds', async () => {
      axios.get
        .mockRejectedValueOnce((() => {
          const e = new Error('Internal Server Error');
          e.response = { status: 500, data: {} };
          return e;
        })())
        .mockResolvedValueOnce({ data: { contacts: [] }, status: 200 });

      const result = await client.getContacts(LOCATION_ID);
      expect(result).toEqual([]);
      expect(axios.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('no retry on 401', () => {
    it('throws immediately without retrying on 401', async () => {
      axios.get.mockRejectedValueOnce((() => {
        const e = new Error('Unauthorized');
        e.response = { status: 401, data: {} };
        return e;
      })());

      await expect(client.getContacts(LOCATION_ID)).rejects.toThrow();
      // Should have been called only once — no retry
      expect(axios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('no retry on other 4xx', () => {
    it('throws immediately without retrying on 400', async () => {
      axios.get.mockRejectedValueOnce((() => {
        const e = new Error('Bad Request');
        e.response = { status: 400, data: {} };
        return e;
      })());

      await expect(client.getContacts(LOCATION_ID)).rejects.toThrow();
      expect(axios.get).toHaveBeenCalledTimes(1);
    });
  });

  // ─── getCalendarEvents ───────────────────────────────────────────────────────

  describe('getCalendarEvents', () => {
    it('calls the correct endpoint', async () => {
      axios.get.mockResolvedValueOnce({ data: { events: [] }, status: 200 });
      await client.getCalendarEvents(LOCATION_ID, '2026-04-01', '2026-04-30');
      const url = axios.get.mock.calls[0][0];
      expect(url).toContain('/calendars/events');
    });

    it('includes locationId, startDate, and endDate in params', async () => {
      axios.get.mockResolvedValueOnce({ data: { events: [] }, status: 200 });
      await client.getCalendarEvents(LOCATION_ID, '2026-04-01', '2026-04-30');
      const callParams = axios.get.mock.calls[0][1].params;
      expect(callParams.locationId).toBe(LOCATION_ID);
      expect(callParams.startDate).toBe('2026-04-01');
      expect(callParams.endDate).toBe('2026-04-30');
    });

    it('returns events array', async () => {
      const events = [{ id: 'ev1' }, { id: 'ev2' }];
      axios.get.mockResolvedValueOnce({ data: { events }, status: 200 });
      const result = await client.getCalendarEvents(LOCATION_ID, '2026-04-01', '2026-04-30');
      expect(result).toEqual(events);
    });
  });
});
