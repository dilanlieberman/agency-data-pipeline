// Unit tests for summarizeTargeting() — adset geo targeting -> client_profile
// location fields (Pinnacle JK Client Management OS, Client Info page).

beforeAll(() => {
  process.env.META_ACCESS_TOKEN = 'test_token';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
});

const mod = () => require('../../scripts/agency-tracker/meta-ad-sync');

describe('summarizeTargeting', () => {
  test('aggregates regions + cities across ACTIVE adsets, dedupes, sorts', () => {
    const { locations, summary } = mod().summarizeTargeting([
      { effective_status: 'ACTIVE', targeting: { geo_locations: {
        regions: [{ name: 'New Jersey' }],
        cities: [{ name: 'Newark', region: 'New Jersey' }, { name: 'Jersey City', region: 'New Jersey' }],
      } } },
      { effective_status: 'ACTIVE', targeting: { geo_locations: {
        cities: [{ name: 'Newark', region: 'New Jersey' }, { name: 'Trenton', region: 'New Jersey' }],
      } } },
    ]);
    expect(locations.states).toEqual(['New Jersey']);
    expect(locations.cities).toEqual(['Jersey City', 'Newark', 'Trenton']);
    expect(summary).toBe('New Jersey — Jersey City, Newark +1');
  });

  test('skips paused adsets', () => {
    const { locations } = mod().summarizeTargeting([
      { effective_status: 'PAUSED', targeting: { geo_locations: { regions: [{ name: 'Texas' }] } } },
      { effective_status: 'ACTIVE', targeting: { geo_locations: { regions: [{ name: 'Florida' }] } } },
    ]);
    expect(locations.states).toEqual(['Florida']);
  });

  test('custom radius locations land in other with radius suffix', () => {
    const { locations, summary } = mod().summarizeTargeting([
      { effective_status: 'ACTIVE', targeting: { geo_locations: {
        custom_locations: [{ address_string: 'Marlboro, NJ', radius: 25, distance_unit: 'mile' }],
      } } },
    ]);
    expect(locations.other).toEqual(['Marlboro, NJ +25mi']);
    expect(summary).toBe('Marlboro, NJ +25mi');
  });

  test('country-only targeting reads US-wide', () => {
    const { summary } = mod().summarizeTargeting([
      { effective_status: 'ACTIVE', targeting: { geo_locations: { countries: ['US'] } } },
    ]);
    expect(summary).toBe('US-wide');
  });

  test('empty input is US-wide with empty lists', () => {
    const { locations, summary, points } = mod().summarizeTargeting([]);
    expect(locations).toEqual({ states: [], cities: [], other: [] });
    expect(summary).toBe('US-wide');
    expect(points).toEqual([]);
  });

  test('lat/lng radius pins become deduped 2dp points for resolve-geo, not raw labels', () => {
    const { locations, points } = mod().summarizeTargeting([
      { effective_status: 'ACTIVE', targeting: { geo_locations: {
        custom_locations: [
          { latitude: 42.081, longitude: -71.401, radius: 3, distance_unit: 'kilometer' },
          { latitude: 42.0812, longitude: -71.4009, radius: 5, distance_unit: 'kilometer' },
          { latitude: 30.31, longitude: -87.43, radius: 8, distance_unit: 'kilometer' },
        ],
      } } },
    ]);
    expect(points).toEqual([{ lat: 42.08, lng: -71.4 }, { lat: 30.31, lng: -87.43 }]);
    expect(locations.other).toEqual([]);
  });

  test('buildTargetingSummary formats states + top cities', () => {
    expect(mod().buildTargetingSummary({
      states: ['Massachusetts'],
      cities: ['Boston', 'Framingham', 'Newton'],
      other: [],
    })).toBe('Massachusetts — Boston, Framingham +1');
  });
});
