// Unit tests for the Today / 7d_plus_today window math in meta-ad-sync.js.
// Live pull is verified on the VPS (plan Task 3) — here we only test date math
// and the PULLS param builders (no Meta / Supabase calls).

beforeAll(() => {
  process.env.META_ACCESS_TOKEN = 'test_token';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
});

const mod = () => require('../../scripts/agency-tracker/meta-ad-sync');

describe('todayInTz / minusDays', () => {
  test('todayInTz returns YYYY-MM-DD', () => {
    expect(mod().todayInTz('America/New_York')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('todayInTz honors the timezone parameter', () => {
    // Kiritimati (UTC+14) is never on an earlier calendar date than Niue (UTC-11).
    const a = mod().todayInTz('Pacific/Kiritimati');
    const b = mod().todayInTz('Pacific/Niue');
    expect(a >= b).toBe(true);
  });

  test('minusDays does exact calendar arithmetic incl. month/year boundaries', () => {
    expect(mod().minusDays('2026-07-06', 7)).toBe('2026-06-29');
    expect(mod().minusDays('2026-03-02', 7)).toBe('2026-02-23');
    expect(mod().minusDays('2026-01-03', 7)).toBe('2025-12-27');
  });
});

describe('PULLS', () => {
  test('exactly the transition preset set, in order', () => {
    expect(mod().PULLS.map((p) => p.key)).toEqual([
      'today', '7d_plus_today', 'maximum', 'last_7d', 'last_30d',
    ]);
  });

  test('today pull uses Meta date_preset today (account-TZ midnight)', () => {
    const p = mod().PULLS.find((x) => x.key === 'today');
    expect(p.params({ timezone_name: 'America/Chicago' })).toEqual({ date_preset: 'today' });
  });

  test('7d_plus_today is a single time_range of today-7 .. today in account tz', () => {
    const p = mod().PULLS.find((x) => x.key === '7d_plus_today');
    const { todayInTz, minusDays } = mod();
    const t = todayInTz('America/Chicago');
    expect(p.params({ timezone_name: 'America/Chicago' })).toEqual({
      time_range: JSON.stringify({ since: minusDays(t, 7), until: t }),
    });
  });

  test('buildRow stamps the new preset into id + carries account_timezone', () => {
    const row = mod().buildRow(
      { id: 'act_1', name: 'X', business: { name: 'X' }, timezone_name: 'America/New_York' },
      '7d_plus_today',
      { ad_id: 'ad_1', ad_name: 'A', campaign_name: 'C', adset_name: 'AS',
        spend: '10', impressions: '100', reach: '90', clicks: '5',
        inline_link_clicks: '4', unique_inline_link_clicks: '4',
        unique_inline_link_click_ctr: '4', cost_per_unique_inline_link_click: '2.5',
        cpm: '10', actions: [], video_thruplay_watched_actions: [],
        video_avg_time_watched_actions: [] },
    );
    expect(row.id).toBe('ad_1:7d_plus_today');
    expect(row.date_preset).toBe('7d_plus_today');
    expect(row.account_timezone).toBe('America/New_York');
  });
});
