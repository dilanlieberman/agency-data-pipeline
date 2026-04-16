const {
  computePL,
  RETAINER_RATE,
  TRIAL_RATE,
  SEO_RATE,
  SMS_COST,
  GHL_SUB,
  GOCARDLESS_FEE_PCT,
  GOCARDLESS_FEE_FLAT,
  WHOP_FEE_PCT,
} = require('../../scripts/agency-tracker/lib/pl');
const { PPA_RATE, CLOSER_COMP } = require('../../scripts/agency-tracker/lib/config');

describe('computePL', () => {
  describe('PPA revenue', () => {
    test('sums qualified appts across 3 clients at $100 each', () => {
      const result = computePL({
        ppaRows: [
          { appts_qualified: 8 },
          { appts_qualified: 12 },
          { appts_qualified: 5 },
        ],
      });

      expect(result.revenue.ppa).toBe(25 * PPA_RATE); // 2500
      expect(result.revenue.ppa).toBe(2500);
    });
  });

  describe('retainer revenue', () => {
    test('counts only active retainer clients at $2,500 each', () => {
      const result = computePL({
        retainerClients: [
          { status: 'active', monthly_rate: 2500 },
          { status: 'active', monthly_rate: 2500 },
          { status: 'churned', monthly_rate: 2500 },
        ],
      });

      expect(result.revenue.retainer).toBe(2 * RETAINER_RATE); // 5000
      expect(result.revenue.retainer).toBe(5000);
    });
  });

  describe('trial revenue', () => {
    test('counts trial closes from closer row at $250 each', () => {
      const result = computePL({
        closerRow: {
          retainer_closes: 0,
          trial_closes: 4,
          builder_closes: 0,
          builder_downsell_closes: 0,
          retainer_upgrades: 0,
        },
      });

      expect(result.revenue.trial).toBe(4 * TRIAL_RATE); // 1000
    });
  });

  describe('builder and manual revenue', () => {
    test('sums builder entry fees from pipeline', () => {
      const result = computePL({
        builderPipeline: [
          { entry_fee_paid: 1500 },
          { entry_fee_paid: 2000 },
        ],
      });

      expect(result.revenue.builder_entry).toBe(3500);
    });

    test('includes manual builder revshare, website revshare, and SEO', () => {
      const result = computePL({
        manualRevenue: {
          builder_revshare: 800,
          website_revshare: 2400,
          seo_client_count: 3,
        },
      });

      expect(result.revenue.builder_revshare).toBe(800);
      expect(result.revenue.website_revshare).toBe(2400);
      expect(result.revenue.seo).toBe(3 * SEO_RATE); // 591
    });
  });

  describe('cost calculations', () => {
    test('SMS cost = totalSmsSent * $0.0166', () => {
      const result = computePL({ totalSmsSent: 5000 });

      expect(result.costs.sms).toBe(Math.round(5000 * SMS_COST * 100) / 100); // 83
    });

    test('setter commissions summed from setter rows', () => {
      const result = computePL({
        setterRows: [
          { commission_owed: 500 },
          { commission_owed: 750 },
          { commission_owed: 250 },
        ],
      });

      expect(result.costs.setter_commission).toBe(1500);
    });

    test('closer commission uses CLOSER_COMP rates', () => {
      const closerRow = {
        retainer_closes: 2,
        trial_closes: 3,
        builder_closes: 1,
        builder_downsell_closes: 1,
        retainer_upgrades: 1,
      };

      const result = computePL({ closerRow });

      const expected =
        2 * CLOSER_COMP.retainer_close +   // 1500
        3 * CLOSER_COMP.trial_close +      // 750
        1 * CLOSER_COMP.builder_close +    // 750
        1 * CLOSER_COMP.builder_downsell + // 500
        1 * CLOSER_COMP.retainer_upgrade;  // 750

      expect(result.costs.closer_commission).toBe(expected); // 4250
      expect(result.costs.closer_commission).toBe(4250);
    });

    test('GHL subscription is flat $297', () => {
      const result = computePL({});

      expect(result.costs.ghl_sub).toBe(GHL_SUB);
      expect(result.costs.ghl_sub).toBe(297);
    });

    test('GoCardless fees = 1% of amount + $0.20 per transaction', () => {
      const result = computePL({
        manualRevenue: {
          total_payments_count: 10,
          total_payments_amount: 8000,
        },
      });

      // 8000 * 0.01 + 10 * 0.20 = 80 + 2 = 82
      expect(result.costs.gocardless_fees).toBe(82);
    });

    test('Whop fees = 3% of Whop revenue', () => {
      const result = computePL({
        manualRevenue: { whop_revenue: 1000 },
      });

      expect(result.costs.whop_fees).toBe(30);
    });
  });

  describe('profit and margin', () => {
    test('profit = revenue.total - costs.total', () => {
      const result = computePL({
        ppaRows: [{ appts_qualified: 20 }],           // 2000 revenue
        retainerClients: [{ status: 'active' }],       // 2500 revenue
        closerRow: {
          retainer_closes: 1,
          trial_closes: 2,
          builder_closes: 0,
          builder_downsell_closes: 0,
          retainer_upgrades: 0,
        },
        setterRows: [{ commission_owed: 500 }],
        totalSmsSent: 1000,
        manualRevenue: {
          seo_client_count: 1,
          total_payments_count: 5,
          total_payments_amount: 4500,
        },
      });

      // Revenue: 2000 + 2500 + 500 + 0 + 0 + 0 + 197 = 5197
      expect(result.revenue.total).toBe(5197);

      // Costs: sms(16.60) + setter(500) + closer(1250) + ghl(297) + gc(65) + whop(0) = 2128.60
      const expectedCosts = Math.round((1000 * SMS_COST) * 100) / 100  // 16.60
        + 500                                                            // setter
        + (1 * CLOSER_COMP.retainer_close + 2 * CLOSER_COMP.trial_close) // 1250
        + GHL_SUB                                                        // 297
        + Math.round((4500 * GOCARDLESS_FEE_PCT + 5 * GOCARDLESS_FEE_FLAT) * 100) / 100 // 46
        + 0;                                                             // whop
      expect(result.costs.total).toBe(expectedCosts);

      expect(result.profit).toBe(Math.round((result.revenue.total - result.costs.total) * 100) / 100);
    });

    test('margin_pct = (profit / revenue.total) * 100, rounded to 2 decimals', () => {
      const result = computePL({
        ppaRows: [{ appts_qualified: 10 }], // 1000
        retainerClients: [{ status: 'active' }], // 2500
      });

      // Revenue = 3500, costs = 297 (ghl only), profit = 3203
      expect(result.revenue.total).toBe(3500);
      expect(result.costs.total).toBe(297);
      expect(result.profit).toBe(3203);
      expect(result.margin_pct).toBe(parseFloat(((3203 / 3500) * 100).toFixed(2)));
    });
  });

  describe('edge case: all zeros', () => {
    test('returns zero revenue, GHL sub as only cost, negative profit', () => {
      const result = computePL({});

      expect(result.revenue.ppa).toBe(0);
      expect(result.revenue.retainer).toBe(0);
      expect(result.revenue.trial).toBe(0);
      expect(result.revenue.builder_entry).toBe(0);
      expect(result.revenue.builder_revshare).toBe(0);
      expect(result.revenue.website_revshare).toBe(0);
      expect(result.revenue.seo).toBe(0);
      expect(result.revenue.total).toBe(0);

      expect(result.costs.sms).toBe(0);
      expect(result.costs.setter_commission).toBe(0);
      expect(result.costs.closer_commission).toBe(0);
      expect(result.costs.ghl_sub).toBe(297);
      expect(result.costs.gocardless_fees).toBe(0);
      expect(result.costs.whop_fees).toBe(0);
      expect(result.costs.total).toBe(297);

      expect(result.profit).toBe(-297);
      // margin_pct is 0 when revenue is 0 (avoid division by zero)
      expect(result.margin_pct).toBe(0);
    });
  });
});
