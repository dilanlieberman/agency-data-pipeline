// Tests for meta-ad-history-backfill.js pure functions:
//   buildDailyRow, computeSummary, detectSwaps

// Stub env before any module loads that might read it.
beforeAll(() => {
  process.env.META_ACCESS_TOKEN = 'test_token';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_key';
});

const {
  buildDailyRow,
  computeSummary,
  detectSwaps,
  extractCreative,
} = require('../../scripts/agency-tracker/meta-ad-history-backfill');

// ─────────────────────────────────────────────────────────────────────────────
// buildDailyRow
// ─────────────────────────────────────────────────────────────────────────────

describe('buildDailyRow', () => {
  const account = {
    id: 'act_123',
    name: 'Greenstone x Pinnacle',
    business: { name: 'Greenstone' },
  };

  test('image ad with leads and link clicks — all fields populated', () => {
    const raw = {
      ad_id: 'ad_100',
      ad_name: '4 Collage | Image | I know',
      campaign_name: 'Lead Gen - Greenstone',
      adset_name: 'NJ 25+',
      date_start: '2026-04-10',
      date_stop: '2026-04-10',
      spend: '87.50',
      impressions: '4200',
      reach: '3800',
      clicks: '110',
      inline_link_clicks: '85',
      unique_inline_link_clicks: '78',
      actions: [
        { action_type: 'lead', value: '3' },
        { action_type: 'onsite_conversion.lead_grouped', value: '3' },
        { action_type: 'landing_page_view', value: '60' },
        { action_type: 'video_view', value: '0' },
      ],
      video_thruplay_watched_actions: [],
      video_avg_time_watched_actions: [],
    };

    const row = buildDailyRow(account, raw);

    expect(row.id).toBe('ad_100:2026-04-10');
    expect(row.ad_id).toBe('ad_100');
    expect(row.ad_name).toBe('4 Collage | Image | I know');
    expect(row.campaign_name).toBe('Lead Gen - Greenstone');
    expect(row.adset_name).toBe('NJ 25+');
    expect(row.account_id).toBe('act_123');
    expect(row.client_display).toBe('Greenstone');
    expect(row.date_key).toBe('2026-04-10');
    expect(row.spend).toBeCloseTo(87.50, 2);
    expect(row.impressions).toBe(4200);
    expect(row.reach).toBe(3800);
    expect(row.clicks_total).toBe(110);
    expect(row.inline_link_clicks).toBe(85);
    expect(row.unique_inline_link_clicks).toBe(78);
    // leads: MAX across lead types → 3 (not sum 6)
    expect(row.leads).toBe(3);
    expect(row.landing_page_views).toBe(60);

    // Derived metrics should be non-null and reasonable
    expect(row.cpl).toBeCloseTo(87.50 / 3, 2);          // ~29.17
    expect(row.ctr_link).toBeCloseTo((85 / 4200) * 100, 2);
    expect(row.ctr_all).toBeCloseTo((110 / 4200) * 100, 2);
    expect(row.cpm).toBeCloseTo((87.50 / 4200) * 1000, 2);
    expect(row.cpc_link).toBeCloseTo(87.50 / 85, 2);
    expect(row.lpv_to_lead_pct).toBeCloseTo((3 / 60) * 100, 2);
    expect(row.imp_to_lead).toBe(Math.round(4200 / 3));
    expect(row.low_signal).toBe(false);

    // No video data → null hook/hold
    expect(row.hook_rate).toBeNull();
    expect(row.hold_rate).toBeNull();
    expect(row.video_3s_views).toBe(0);
    expect(row.video_thruplays).toBe(0);
    expect(row.video_avg_watch_seconds).toBeNull();

    // Must have pulled_at timestamp
    expect(typeof row.pulled_at).toBe('string');
  });

  test('low signal — spend < $5', () => {
    const raw = {
      ad_id: 'ad_200',
      ad_name: 'Test Ad',
      campaign_name: 'Campaign A',
      adset_name: 'Adset A',
      date_start: '2026-04-11',
      date_stop: '2026-04-11',
      spend: '3.20',
      impressions: '150',
      reach: '140',
      clicks: '5',
      inline_link_clicks: '3',
      unique_inline_link_clicks: '3',
      actions: [],
      video_thruplay_watched_actions: [],
      video_avg_time_watched_actions: [],
    };

    const row = buildDailyRow(account, raw);
    expect(row.low_signal).toBe(true);
    expect(row.leads).toBe(0);
    // No leads → CPL null
    expect(row.cpl).toBeNull();
  });

  test('video ad with hook/hold data', () => {
    const raw = {
      ad_id: 'ad_300',
      ad_name: 'Video | Stress Free',
      campaign_name: 'Campaign V',
      adset_name: 'Adset V',
      date_start: '2026-04-12',
      date_stop: '2026-04-12',
      spend: '60.00',
      impressions: '3000',
      reach: '2500',
      clicks: '80',
      inline_link_clicks: '50',
      unique_inline_link_clicks: '45',
      actions: [
        { action_type: 'lead', value: '2' },
        { action_type: 'landing_page_view', value: '40' },
        { action_type: 'video_view', value: '900' },
      ],
      video_thruplay_watched_actions: [
        { action_type: 'video_view', value: '200' },
      ],
      video_avg_time_watched_actions: [
        { action_type: 'video_view', value: '7.5' },
      ],
    };

    const row = buildDailyRow(account, raw);
    expect(row.video_3s_views).toBe(900);
    expect(row.video_thruplays).toBe(200);
    expect(row.video_avg_watch_seconds).toBe(7.5);
    expect(row.hook_rate).toBeCloseTo((900 / 3000) * 100, 2);   // 30%
    expect(row.hold_rate).toBeCloseTo((200 / 900) * 100, 2);    // 22.22%
    expect(row.avg_watch_time).toBeCloseTo(7.5, 2);
  });

  test('zero-spend day — derived metrics should be null', () => {
    const raw = {
      ad_id: 'ad_400',
      ad_name: 'Paused Ad',
      campaign_name: 'Campaign Z',
      adset_name: 'Adset Z',
      date_start: '2026-04-13',
      date_stop: '2026-04-13',
      spend: '0',
      impressions: '0',
      reach: '0',
      clicks: '0',
      inline_link_clicks: '0',
      unique_inline_link_clicks: '0',
      actions: [],
      video_thruplay_watched_actions: [],
      video_avg_time_watched_actions: [],
    };

    const row = buildDailyRow(account, raw);
    expect(row.spend).toBe(0);
    expect(row.cpl).toBeNull();
    expect(row.ctr_link).toBeNull();
    expect(row.ctr_all).toBeNull();
    expect(row.cpm).toBeNull();
    expect(row.cpc_link).toBeNull();
    expect(row.hook_rate).toBeNull();
    expect(row.hold_rate).toBeNull();
    expect(row.imp_to_lead).toBeNull();
    expect(row.low_signal).toBe(true); // spend 0 < 5
  });

  test('LPV fallback to omni_landing_page_view', () => {
    const raw = {
      ad_id: 'ad_500',
      ad_name: 'Omni Ad',
      campaign_name: 'C',
      adset_name: 'AS',
      date_start: '2026-04-14',
      date_stop: '2026-04-14',
      spend: '20',
      impressions: '1000',
      reach: '900',
      clicks: '30',
      inline_link_clicks: '20',
      unique_inline_link_clicks: '18',
      actions: [
        { action_type: 'omni_landing_page_view', value: '15' },
      ],
      video_thruplay_watched_actions: [],
      video_avg_time_watched_actions: [],
    };

    const row = buildDailyRow(account, raw);
    expect(row.landing_page_views).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeSummary
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSummary', () => {
  const creative = {
    primary_text: 'I know...',
    headline: 'Get A New Bathroom',
    description: 'Stars',
    call_to_action: 'LEARN_MORE',
    creative_type: 'image',
    creative_id: 'cr_1',
    creative_thumbnail_url: 'https://example.com/thumb.jpg',
    creative_video_id: null,
    creative_video_url: null,
    ad_created_time: '2026-04-01T00:00:00Z',
    effective_status: 'ACTIVE',
  };

  test('multiple daily rows aggregated correctly', () => {
    const rows = [
      {
        ad_id: 'ad_100', ad_name: '4 Collage | Image | I know',
        campaign_name: 'Campaign A', adset_name: 'AS A',
        account_id: 'act_123', client_display: 'Greenstone',
        date_key: '2026-04-10',
        spend: 50, impressions: 2000, leads: 2, landing_page_views: 30,
        inline_link_clicks: 40, video_3s_views: 0, video_thruplays: 0,
      },
      {
        ad_id: 'ad_100', ad_name: '4 Collage | Image | I know',
        campaign_name: 'Campaign A', adset_name: 'AS A',
        account_id: 'act_123', client_display: 'Greenstone',
        date_key: '2026-04-11',
        spend: 70, impressions: 3000, leads: 3, landing_page_views: 50,
        inline_link_clicks: 60, video_3s_views: 0, video_thruplays: 0,
      },
      {
        ad_id: 'ad_100', ad_name: '4 Collage | Image | I know',
        campaign_name: 'Campaign A', adset_name: 'AS A',
        account_id: 'act_123', client_display: 'Greenstone',
        date_key: '2026-04-12',
        spend: 0, impressions: 0, leads: 0, landing_page_views: 0,
        inline_link_clicks: 0, video_3s_views: 0, video_thruplays: 0,
      },
    ];

    const summary = computeSummary(rows, creative);

    expect(summary.ad_id).toBe('ad_100');
    expect(summary.total_spend).toBe(120);
    expect(summary.total_impressions).toBe(5000);
    expect(summary.total_leads).toBe(5);
    expect(summary.total_lpv).toBe(80);
    expect(summary.total_link_clicks).toBe(100);
    expect(summary.lifetime_cpl).toBeCloseTo(120 / 5, 2);       // 24
    expect(summary.lifetime_ctr_link).toBeCloseTo((100 / 5000) * 100, 2); // 2%
    expect(summary.active_days).toBe(2);  // day 3 had 0 spend
    expect(summary.first_spend_date).toBe('2026-04-10');
    expect(summary.last_spend_date).toBe('2026-04-11');

    // Creative pass-through
    expect(summary.primary_text).toBe('I know...');
    expect(summary.headline).toBe('Get A New Bathroom');
    expect(summary.creative_type).toBe('image');

    // matchConcept on ad_name
    expect(summary.ad_copy_concept).toBe('i_know');

    // No video data → null hook/hold
    expect(summary.lifetime_hook_rate).toBeNull();
    expect(summary.lifetime_hold_rate).toBeNull();
  });

  test('zero denominators → null lifetime metrics', () => {
    const rows = [
      {
        ad_id: 'ad_200', ad_name: 'Unknown Ad',
        campaign_name: 'C', adset_name: 'AS',
        account_id: 'act_456', client_display: 'Client',
        date_key: '2026-04-10',
        spend: 0, impressions: 0, leads: 0, landing_page_views: 0,
        inline_link_clicks: 0, video_3s_views: 0, video_thruplays: 0,
      },
    ];

    const summary = computeSummary(rows, {});

    expect(summary.lifetime_cpl).toBeNull();
    expect(summary.lifetime_ctr_link).toBeNull();
    expect(summary.lifetime_hook_rate).toBeNull();
    expect(summary.lifetime_hold_rate).toBeNull();
    expect(summary.lifetime_lpv_to_lead_pct).toBeNull();
    expect(summary.active_days).toBe(0);
    expect(summary.first_spend_date).toBeNull();
    expect(summary.last_spend_date).toBeNull();
  });

  test('active_days counts only days with spend > 0', () => {
    const rows = [
      { ad_id: 'ad_x', ad_name: 'X', campaign_name: 'C', adset_name: 'A',
        account_id: 'a', client_display: 'C', date_key: '2026-04-01',
        spend: 10, impressions: 500, leads: 1, landing_page_views: 5,
        inline_link_clicks: 10, video_3s_views: 0, video_thruplays: 0 },
      { ad_id: 'ad_x', ad_name: 'X', campaign_name: 'C', adset_name: 'A',
        account_id: 'a', client_display: 'C', date_key: '2026-04-02',
        spend: 0, impressions: 0, leads: 0, landing_page_views: 0,
        inline_link_clicks: 0, video_3s_views: 0, video_thruplays: 0 },
      { ad_id: 'ad_x', ad_name: 'X', campaign_name: 'C', adset_name: 'A',
        account_id: 'a', client_display: 'C', date_key: '2026-04-03',
        spend: 15, impressions: 600, leads: 0, landing_page_views: 8,
        inline_link_clicks: 12, video_3s_views: 0, video_thruplays: 0 },
    ];

    const summary = computeSummary(rows, {});
    expect(summary.active_days).toBe(2);
  });

  test('first/last_spend_date correct even if unsorted input', () => {
    const rows = [
      { ad_id: 'ad_x', ad_name: 'X', campaign_name: 'C', adset_name: 'A',
        account_id: 'a', client_display: 'C', date_key: '2026-04-15',
        spend: 5, impressions: 100, leads: 0, landing_page_views: 0,
        inline_link_clicks: 5, video_3s_views: 0, video_thruplays: 0 },
      { ad_id: 'ad_x', ad_name: 'X', campaign_name: 'C', adset_name: 'A',
        account_id: 'a', client_display: 'C', date_key: '2026-04-10',
        spend: 8, impressions: 200, leads: 1, landing_page_views: 2,
        inline_link_clicks: 8, video_3s_views: 0, video_thruplays: 0 },
      { ad_id: 'ad_x', ad_name: 'X', campaign_name: 'C', adset_name: 'A',
        account_id: 'a', client_display: 'C', date_key: '2026-04-12',
        spend: 0, impressions: 0, leads: 0, landing_page_views: 0,
        inline_link_clicks: 0, video_3s_views: 0, video_thruplays: 0 },
    ];

    const summary = computeSummary(rows, {});
    expect(summary.first_spend_date).toBe('2026-04-10');
    expect(summary.last_spend_date).toBe('2026-04-15');
  });

  test('ad_copy_concept populated from matchConcept', () => {
    const rows = [
      { ad_id: 'ad_sf', ad_name: 'Video | Stress Free | V2',
        campaign_name: 'C', adset_name: 'A',
        account_id: 'a', client_display: 'C', date_key: '2026-04-01',
        spend: 20, impressions: 1000, leads: 1, landing_page_views: 10,
        inline_link_clicks: 15, video_3s_views: 0, video_thruplays: 0 },
    ];

    const summary = computeSummary(rows, {});
    expect(summary.ad_copy_concept).toBe('stress_free');
  });

  test('video ad summary with hook/hold rates', () => {
    const rows = [
      { ad_id: 'ad_v', ad_name: 'Video Ad',
        campaign_name: 'C', adset_name: 'A',
        account_id: 'a', client_display: 'C', date_key: '2026-04-01',
        spend: 50, impressions: 2000, leads: 2, landing_page_views: 20,
        inline_link_clicks: 30, video_3s_views: 600, video_thruplays: 120 },
      { ad_id: 'ad_v', ad_name: 'Video Ad',
        campaign_name: 'C', adset_name: 'A',
        account_id: 'a', client_display: 'C', date_key: '2026-04-02',
        spend: 40, impressions: 1500, leads: 1, landing_page_views: 15,
        inline_link_clicks: 25, video_3s_views: 400, video_thruplays: 80 },
    ];

    const summary = computeSummary(rows, { creative_type: 'video' });
    // total v3s = 1000, total impressions = 3500
    expect(summary.lifetime_hook_rate).toBeCloseTo((1000 / 3500) * 100, 2);
    // total thruplays = 200, total v3s = 1000
    expect(summary.lifetime_hold_rate).toBeCloseTo((200 / 1000) * 100, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectSwaps
// ─────────────────────────────────────────────────────────────────────────────

describe('detectSwaps', () => {
  // Helper to make a summary with the fields detectSwaps cares about.
  function makeSummary(overrides) {
    return {
      ad_id: 'ad_1',
      ad_name: 'Ad 1',
      account_id: 'act_123',
      client_display: 'Client',
      campaign_name: 'Campaign A',
      total_spend: 500,
      total_leads: 20,
      total_link_clicks: 200,
      total_impressions: 10000,
      lifetime_cpl: 25,
      lifetime_ctr_link: 2.0,
      lifetime_hook_rate: null,
      first_spend_date: '2026-04-01',
      last_spend_date: '2026-04-15',
      ...overrides,
    };
  }

  // Helper to make daily rows for an ad
  function makeDailyRows(adId, dates) {
    return dates.map((d) => ({
      ad_id: adId,
      date_key: d.date,
      spend: d.spend != null ? d.spend : 10,
    }));
  }

  test('clean swap (gap <= 5 days, no overlap) → transition_type swap', () => {
    const oldAd = makeSummary({
      ad_id: 'ad_old',
      ad_name: 'Old Ad',
      first_spend_date: '2026-04-01',
      last_spend_date: '2026-04-10',
      lifetime_cpl: 30,
      lifetime_ctr_link: 1.8,
    });
    const newAd = makeSummary({
      ad_id: 'ad_new',
      ad_name: 'New Ad',
      first_spend_date: '2026-04-12',  // 2 days after old last_spend
      last_spend_date: '2026-04-25',
      total_spend: 300,
      total_leads: 15,
      lifetime_cpl: 20,
      lifetime_ctr_link: 2.5,
    });

    const dailyByAd = {
      ad_old: makeDailyRows('ad_old', [
        { date: '2026-04-09', spend: 10 },
        { date: '2026-04-10', spend: 10 },
      ]),
      ad_new: makeDailyRows('ad_new', [
        { date: '2026-04-12', spend: 10 },
        { date: '2026-04-13', spend: 10 },
      ]),
    };

    const swaps = detectSwaps([oldAd, newAd], dailyByAd);
    expect(swaps).toHaveLength(1);
    expect(swaps[0].transition_type).toBe('swap');
    expect(swaps[0].old_ad_id).toBe('ad_old');
    expect(swaps[0].new_ad_id).toBe('ad_new');
    expect(swaps[0].gap_days).toBe(2);
    // CPL improved from 30 → 20 = ((30-20)/30)*100 = 33.33%
    expect(swaps[0].improvement_cpl_pct).toBeCloseTo(33.33, 1);
    // CTR improved from 1.8 → 2.5 = ((2.5-1.8)/1.8)*100 = 38.89%
    expect(swaps[0].improvement_ctr_pct).toBeCloseTo(38.89, 1);
    // CPL improved >= 10% AND CTR improved → win
    expect(swaps[0].verdict).toBe('win');
  });

  test('A/B test conclusion (overlap >= 5 days) → transition_type ab_test_conclusion', () => {
    const adA = makeSummary({
      ad_id: 'ad_a',
      ad_name: 'Ad A',
      first_spend_date: '2026-04-01',
      last_spend_date: '2026-04-20',
      lifetime_cpl: 25,
      lifetime_ctr_link: 2.0,
    });
    const adB = makeSummary({
      ad_id: 'ad_b',
      ad_name: 'Ad B',
      first_spend_date: '2026-04-10',  // within 5 days of A's last
      last_spend_date: '2026-04-30',
      total_spend: 400,
      total_leads: 18,
      lifetime_cpl: 22,
      lifetime_ctr_link: 2.3,
    });

    // Overlap days: 2026-04-10 through 2026-04-20 = 11 days both active
    const dailyOld = [];
    const dailyNew = [];
    for (let d = 1; d <= 20; d++) {
      dailyOld.push({ date: `2026-04-${String(d).padStart(2, '0')}`, spend: 10 });
    }
    for (let d = 10; d <= 30; d++) {
      dailyNew.push({ date: `2026-04-${String(d).padStart(2, '0')}`, spend: 10 });
    }

    const dailyByAd = {
      ad_a: makeDailyRows('ad_a', dailyOld),
      ad_b: makeDailyRows('ad_b', dailyNew),
    };

    const swaps = detectSwaps([adA, adB], dailyByAd);
    expect(swaps).toHaveLength(1);
    expect(swaps[0].transition_type).toBe('ab_test_conclusion');
    expect(swaps[0].overlap_days).toBeGreaterThanOrEqual(5);
  });

  test('insufficient_data when new ad has < $10 spend', () => {
    const oldAd = makeSummary({
      ad_id: 'ad_old2',
      ad_name: 'Old Ad 2',
      first_spend_date: '2026-04-01',
      last_spend_date: '2026-04-10',
      lifetime_cpl: 30,
      lifetime_ctr_link: 2.0,
    });
    const newAd = makeSummary({
      ad_id: 'ad_new2',
      ad_name: 'New Ad 2',
      first_spend_date: '2026-04-12',
      last_spend_date: '2026-04-13',
      total_spend: 8,  // < $10
      total_leads: 1,
      lifetime_cpl: 8,
      lifetime_ctr_link: 3.0,
    });

    const dailyByAd = {
      ad_old2: makeDailyRows('ad_old2', [{ date: '2026-04-10', spend: 10 }]),
      ad_new2: makeDailyRows('ad_new2', [{ date: '2026-04-12', spend: 5 }]),
    };

    const swaps = detectSwaps([oldAd, newAd], dailyByAd);
    expect(swaps).toHaveLength(1);
    expect(swaps[0].verdict).toBe('insufficient_data');
  });

  test('insufficient_data when new ad has 0 leads', () => {
    const oldAd = makeSummary({
      ad_id: 'ad_old3',
      first_spend_date: '2026-04-01',
      last_spend_date: '2026-04-10',
      lifetime_cpl: 25,
      lifetime_ctr_link: 2.0,
    });
    const newAd = makeSummary({
      ad_id: 'ad_new3',
      first_spend_date: '2026-04-12',
      last_spend_date: '2026-04-20',
      total_spend: 50,
      total_leads: 0,  // 0 leads
      lifetime_cpl: null,
      lifetime_ctr_link: 1.5,
    });

    const dailyByAd = {
      ad_old3: makeDailyRows('ad_old3', [{ date: '2026-04-10', spend: 10 }]),
      ad_new3: makeDailyRows('ad_new3', [{ date: '2026-04-12', spend: 10 }]),
    };

    const swaps = detectSwaps([oldAd, newAd], dailyByAd);
    expect(swaps).toHaveLength(1);
    expect(swaps[0].verdict).toBe('insufficient_data');
  });

  test('no swap when ads are in different campaigns', () => {
    const adA = makeSummary({
      ad_id: 'ad_c1',
      campaign_name: 'Campaign X',
      first_spend_date: '2026-04-01',
      last_spend_date: '2026-04-10',
    });
    const adB = makeSummary({
      ad_id: 'ad_c2',
      campaign_name: 'Campaign Y',   // different campaign
      first_spend_date: '2026-04-12',
      last_spend_date: '2026-04-25',
    });

    const dailyByAd = {
      ad_c1: makeDailyRows('ad_c1', [{ date: '2026-04-10', spend: 10 }]),
      ad_c2: makeDailyRows('ad_c2', [{ date: '2026-04-12', spend: 10 }]),
    };

    const swaps = detectSwaps([adA, adB], dailyByAd);
    expect(swaps).toHaveLength(0);
  });

  test('loss verdict when CPL worsened >= 10%', () => {
    const oldAd = makeSummary({
      ad_id: 'ad_loss_old',
      ad_name: 'Old Winner',
      first_spend_date: '2026-04-01',
      last_spend_date: '2026-04-10',
      lifetime_cpl: 20,
      lifetime_ctr_link: 2.5,
    });
    const newAd = makeSummary({
      ad_id: 'ad_loss_new',
      ad_name: 'New Loser',
      first_spend_date: '2026-04-12',
      last_spend_date: '2026-04-25',
      total_spend: 500,
      total_leads: 15,
      lifetime_cpl: 33.33,     // CPL went UP from 20 → 33.33 (worsened 66.7%)
      lifetime_ctr_link: 1.8,
    });

    const dailyByAd = {
      ad_loss_old: makeDailyRows('ad_loss_old', [{ date: '2026-04-10', spend: 10 }]),
      ad_loss_new: makeDailyRows('ad_loss_new', [{ date: '2026-04-12', spend: 10 }]),
    };

    const swaps = detectSwaps([oldAd, newAd], dailyByAd);
    expect(swaps).toHaveLength(1);
    expect(swaps[0].verdict).toBe('loss');
    // improvement_cpl_pct should be negative (worsened)
    expect(swaps[0].improvement_cpl_pct).toBeLessThan(-10);
  });

  test('mixed verdict when CPL improved but CTR and hook_rate did not', () => {
    const oldAd = makeSummary({
      ad_id: 'ad_mix_old',
      first_spend_date: '2026-04-01',
      last_spend_date: '2026-04-10',
      lifetime_cpl: 30,
      lifetime_ctr_link: 3.0,
      lifetime_hook_rate: 25,
    });
    const newAd = makeSummary({
      ad_id: 'ad_mix_new',
      first_spend_date: '2026-04-12',
      last_spend_date: '2026-04-25',
      total_spend: 400,
      total_leads: 20,
      lifetime_cpl: 20,           // CPL improved
      lifetime_ctr_link: 2.5,     // CTR worsened
      lifetime_hook_rate: 20,     // hook_rate worsened
    });

    const dailyByAd = {
      ad_mix_old: makeDailyRows('ad_mix_old', [{ date: '2026-04-10', spend: 10 }]),
      ad_mix_new: makeDailyRows('ad_mix_new', [{ date: '2026-04-12', spend: 10 }]),
    };

    const swaps = detectSwaps([oldAd, newAd], dailyByAd);
    expect(swaps).toHaveLength(1);
    // CPL improved >= 10% BUT neither CTR nor hook_rate improved → mixed
    expect(swaps[0].verdict).toBe('mixed');
  });

  test('no swap when gap > 5 days', () => {
    const adA = makeSummary({
      ad_id: 'ad_far_old',
      first_spend_date: '2026-04-01',
      last_spend_date: '2026-04-05',
    });
    const adB = makeSummary({
      ad_id: 'ad_far_new',
      first_spend_date: '2026-04-15',  // 10 days after old's last_spend → too far
      last_spend_date: '2026-04-25',
    });

    const dailyByAd = {
      ad_far_old: makeDailyRows('ad_far_old', [{ date: '2026-04-05', spend: 10 }]),
      ad_far_new: makeDailyRows('ad_far_new', [{ date: '2026-04-15', spend: 10 }]),
    };

    const swaps = detectSwaps([adA, adB], dailyByAd);
    expect(swaps).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractCreative
// ─────────────────────────────────────────────────────────────────────────────

describe('extractCreative', () => {
  const account = {
    id: 'act_123',
    name: 'Greenstone x Pinnacle',
    business: { name: 'Greenstone' },
  };

  test('extracts from link_data (image ad)', () => {
    const ad = {
      creative: {
        thumbnail_url: 'https://example.com/thumb.jpg',
        video_id: null,
        object_story_spec: {
          link_data: {
            message: 'I know...',
            name: 'Get A New Bathroom',
            description: 'Five stars',
            call_to_action: { type: 'LEARN_MORE' },
            child_attachments: null,
          },
        },
      },
    };

    const c = extractCreative(ad, account);
    expect(c.primary_text).toBe('I know...');
    expect(c.headline).toBe('Get A New Bathroom');
    expect(c.description).toBe('Five stars');
    expect(c.call_to_action).toBe('LEARN_MORE');
    expect(c.creative_type).toBe('image');
    expect(c.creative_thumbnail_url).toBe('https://example.com/thumb.jpg');
    expect(c.creative_video_id).toBeNull();
  });

  test('extracts from video_data (video ad)', () => {
    const ad = {
      creative: {
        thumbnail_url: 'https://example.com/video-thumb.jpg',
        video_id: 'vid_999',
        object_story_spec: {
          video_data: {
            message: 'Check this out',
            title: 'Watch Now',
            description: 'Bathroom remodel',
            call_to_action: { type: 'SIGN_UP' },
          },
        },
      },
    };

    const c = extractCreative(ad, account);
    expect(c.primary_text).toBe('Check this out');
    expect(c.headline).toBe('Watch Now');
    expect(c.description).toBe('Bathroom remodel');
    expect(c.call_to_action).toBe('SIGN_UP');
    expect(c.creative_type).toBe('video');
    expect(c.creative_video_id).toBe('vid_999');
    expect(c.creative_video_url).toBeNull(); // lazy-loaded later
  });

  test('carousel detection from child_attachments', () => {
    const ad = {
      creative: {
        thumbnail_url: 'https://example.com/carousel.jpg',
        video_id: null,
        object_story_spec: {
          link_data: {
            message: 'Carousel ad',
            name: 'Browse',
            description: 'Multiple images',
            call_to_action: { type: 'LEARN_MORE' },
            child_attachments: [{}, {}],
          },
        },
      },
    };

    const c = extractCreative(ad, account);
    expect(c.creative_type).toBe('carousel');
  });

  test('graceful fallback on missing creative data', () => {
    const ad = { creative: {} };
    const c = extractCreative(ad, account);
    expect(c.primary_text).toBeNull();
    expect(c.headline).toBeNull();
    expect(c.creative_type).toBe('image');
    expect(c.creative_thumbnail_url).toBeNull();
  });
});
