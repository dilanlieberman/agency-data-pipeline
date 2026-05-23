const { derive } = require('../../scripts/agency-tracker/lib/meta-derive');

describe('meta-derive', () => {
  test('happy path — image ad with leads and link clicks', () => {
    const raw = {
      spend: 100,
      impressions: 10000,
      reach: 8000,
      clicks: 250,
      inline_link_clicks: 200,
      unique_inline_link_clicks: 180,
      leads: 5,
      landing_page_views: 150,
      video_3s_views: 0,
      video_thruplays: 0,
      video_avg_watch_seconds: 0,
    };
    const out = derive(raw);
    expect(out.cpm).toBeCloseTo(10, 2);             // 100/10000*1000
    expect(out.cpc_link).toBeCloseTo(0.5, 2);       // 100/200
    expect(out.cpc_unique_link).toBeCloseTo(100 / 180, 2);
    expect(out.ctr_link).toBeCloseTo(2, 2);         // 200/10000*100
    expect(out.ctr_all).toBeCloseTo(2.5, 2);        // 250/10000*100
    expect(out.unique_ctr).toBeCloseTo((180 / 8000) * 100, 2);
    expect(out.lpv_to_lead_pct).toBeCloseTo((5 / 150) * 100, 2);
    expect(out.imp_to_lead).toBe(2000);             // 10000/5
    expect(out.cpl).toBeCloseTo(20, 2);             // 100/5
    expect(out.cpa).toBeNull();                     // Phase 2 only
    expect(out.hook_rate).toBeNull();               // no video data
    expect(out.hold_rate).toBeNull();
    expect(out.avg_watch_time).toBeNull();
    expect(out.low_signal).toBe(false);
  });

  test('video ad — hook + hold + avg watch populated', () => {
    const raw = {
      spend: 50, impressions: 5000, reach: 4000,
      clicks: 100, inline_link_clicks: 75, unique_inline_link_clicks: 70,
      leads: 2, landing_page_views: 60,
      video_3s_views: 1500, video_thruplays: 300, video_avg_watch_seconds: 8.4,
    };
    const out = derive(raw);
    expect(out.hook_rate).toBeCloseTo(30, 2);       // 1500/5000*100
    expect(out.hold_rate).toBeCloseTo(20, 2);       // 300/1500*100
    expect(out.avg_watch_time).toBeCloseTo(8.4, 2);
  });

  test('divide-by-zero returns null, never Infinity/NaN', () => {
    const raw = {
      spend: 10, impressions: 0, reach: 0,
      clicks: 0, inline_link_clicks: 0, unique_inline_link_clicks: 0,
      leads: 0, landing_page_views: 0,
      video_3s_views: 0, video_thruplays: 0, video_avg_watch_seconds: 0,
    };
    const out = derive(raw);
    for (const [key, val] of Object.entries(out)) {
      if (key === 'low_signal') continue;
      expect(val === null || Number.isFinite(val)).toBe(true);
    }
    expect(out.cpm).toBeNull();
    expect(out.ctr_link).toBeNull();
    expect(out.ctr_all).toBeNull();
    expect(out.hook_rate).toBeNull();
    expect(out.hold_rate).toBeNull();
  });

  test('low_signal flag flips at $5 spend', () => {
    const baseRaw = {
      impressions: 100, reach: 100, clicks: 1, inline_link_clicks: 1,
      unique_inline_link_clicks: 1, leads: 0, landing_page_views: 0,
      video_3s_views: 0, video_thruplays: 0, video_avg_watch_seconds: 0,
    };
    expect(derive({ ...baseRaw, spend: 4.99 }).low_signal).toBe(true);
    expect(derive({ ...baseRaw, spend: 5 }).low_signal).toBe(false);
    expect(derive({ ...baseRaw, spend: 5.01 }).low_signal).toBe(false);
  });

  test('missing optional fields default to 0 without throwing', () => {
    const out = derive({ spend: 10, impressions: 1000 });
    expect(out.cpm).toBeCloseTo(10, 2);
    expect(out.cpc_link).toBeNull();
    expect(out.hook_rate).toBeNull();
  });

  describe('fixture parity with Edge Function', () => {
    const fixture = require('./derive-fixture.json');
    for (const c of fixture.cases) {
      test(`fixture: ${c.name}`, () => {
        const out = derive(c.input);
        for (const [k, v] of Object.entries(c.expected)) {
          if (v === null) expect(out[k]).toBeNull();
          else if (typeof v === 'boolean') expect(out[k]).toBe(v);
          else expect(out[k]).toBeCloseTo(v, 4);
        }
      });
    }
  });
});
