// Tests for custom-range mode in meta-ad-sync.js.
//
// The function (pullCustomRange) takes (account, from, to) and:
//   1. Checks meta_ad_snapshot for fresh cached rows (skip Meta API if any).
//   2. Otherwise pulls via Meta time_range, computes derive(), upserts rows with
//      date_preset = "custom:<from>:<to>".
//
// We don't fully mock Supabase + Meta here — that path is verified end-to-end
// in Task 1A.10 (live smoke test). These tests only assert that:
//   - The module exports pullCustomRange + buildRow + CUSTOM_RANGE_CACHE_WINDOW_MS
//   - The cache window is 1 hour
//   - buildRow stamps date_preset onto the returned row id

// Avoid initializing supabase + dotenv during module load.
beforeAll(() => {
  process.env.META_ACCESS_TOKEN = 'test_token';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
});

describe('meta-ad-sync custom-range exports', () => {
  test('module exports the public surface', () => {
    const mod = require('../../scripts/agency-tracker/meta-ad-sync');
    expect(typeof mod.pullCustomRange).toBe('function');
    expect(typeof mod.buildRow).toBe('function');
    expect(mod.CUSTOM_RANGE_CACHE_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  test('buildRow stamps custom date_preset into the row id', () => {
    const { buildRow } = require('../../scripts/agency-tracker/meta-ad-sync');
    const row = buildRow(
      { id: 'act_25010776835219106', name: 'Pinnacle', business: { name: 'Pinnacle Consulting' } },
      'custom:2026-05-01:2026-05-15',
      {
        ad_id: 'ad_xyz',
        ad_name: 'Test',
        campaign_name: 'C', adset_name: 'AS',
        spend: '100', impressions: '5000', reach: '4000',
        clicks: '120', inline_link_clicks: '80', unique_inline_link_clicks: '75',
        unique_inline_link_click_ctr: '1.88', cost_per_unique_inline_link_click: '1.33',
        cpm: '20', actions: [], video_3_sec_watched_actions: [],
        video_thruplay_watched_actions: [], video_avg_time_watched_actions: [],
      },
    );
    expect(row.id).toBe('ad_xyz:custom:2026-05-01:2026-05-15');
    expect(row.date_preset).toBe('custom:2026-05-01:2026-05-15');
    expect(row.account_id).toBe('act_25010776835219106');
    expect(row.ctr_link).toBeCloseTo((80 / 5000) * 100, 2);
    expect(row.ctr_all).toBeCloseTo((120 / 5000) * 100, 2);
    expect(row.low_signal).toBe(false);  // spend = 100
  });

  test('buildRow flags low_signal for sub-$5 spend', () => {
    const { buildRow } = require('../../scripts/agency-tracker/meta-ad-sync');
    const row = buildRow(
      { id: 'act_x', name: 'X', business: { name: 'X' } },
      'custom:2026-05-01:2026-05-02',
      { ad_id: 'a1', ad_name: 'A', campaign_name: 'C', adset_name: 'AS',
        spend: '2', impressions: '50', reach: '50', clicks: '1',
        inline_link_clicks: '1', unique_inline_link_clicks: '1',
        unique_inline_link_click_ctr: '2', cost_per_unique_inline_link_click: '2',
        cpm: '40', actions: [],
        video_3_sec_watched_actions: [], video_thruplay_watched_actions: [], video_avg_time_watched_actions: [] },
    );
    expect(row.low_signal).toBe(true);
  });
});
