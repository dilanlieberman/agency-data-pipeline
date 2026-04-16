const {
  computeSetterMetrics,
  computeCloserMetrics,
  computePpaClientMetrics,
  computeAgencySnapshot,
  computeLeadBankRunway,
} = require('../../scripts/agency-tracker/lib/metrics');

describe('metrics', () => {
  describe('computeSetterMetrics', () => {
    test('counts closes by pipeline stage', () => {
      const opportunities = [
        { stageId: 'stage-closed-trial', status: 'won', assignedTo: 'cesar' },
        { stageId: 'stage-closed-ppa', status: 'won', assignedTo: 'cesar' },
        { stageId: 'stage-closed-ppa', status: 'won', assignedTo: 'cesar' },
        { stageId: 'stage-call-booked', status: 'open', assignedTo: 'cesar' },
      ];
      const stageMap = {
        'stage-closed-trial': 'Closed trial',
        'stage-closed-ppa': 'Closed PPA',
        'stage-call-booked': 'Call booked',
        'stage-retainer-upgrade': 'Retainer upgrade',
        'stage-week2': 'Week 2 extension',
        'stage-call-showed': 'Call showed',
      };

      const result = computeSetterMetrics(opportunities, stageMap);
      expect(result.closed_trial).toBe(1);
      expect(result.closed_ppa).toBe(2);
      expect(result.calls_booked).toBe(1);
    });

    test('computes close rate as showed → closed %', () => {
      const opportunities = [
        { stageId: 'stage-showed', status: 'won' },
        { stageId: 'stage-showed', status: 'won' },
        { stageId: 'stage-showed', status: 'won' },
        { stageId: 'stage-showed', status: 'won' },
        { stageId: 'stage-closed-trial', status: 'won' },
        { stageId: 'stage-closed-ppa', status: 'won' },
      ];
      const stageMap = {
        'stage-showed': 'Call showed',
        'stage-closed-trial': 'Closed trial',
        'stage-closed-ppa': 'Closed PPA',
      };

      const result = computeSetterMetrics(opportunities, stageMap);
      // 4 at showed + 2 past showed = 6 total showed. 2 closed. 33.33%
      expect(result.close_rate).toBeCloseTo(33.33, 1);
    });

    test('computes commission owed from comp table', () => {
      const opportunities = [
        { stageId: 'stage-closed-trial', status: 'won' },
        { stageId: 'stage-closed-ppa', status: 'won' },
        { stageId: 'stage-closed-ppa', status: 'won' },
      ];
      const stageMap = {
        'stage-closed-trial': 'Closed trial',
        'stage-closed-ppa': 'Closed PPA',
      };

      const result = computeSetterMetrics(opportunities, stageMap);
      // 1 trial × $250 + 2 PPA × $250 = $750
      expect(result.commission_owed).toBe(750);
    });
  });

  describe('computePpaClientMetrics', () => {
    test('counts qualified appts and calculates amount owed', () => {
      const contacts = [
        { tags: ['qualified_appt'], dateAdded: '2026-04-15' },
        { tags: ['qualified_appt'], dateAdded: '2026-04-15' },
        { tags: [], dateAdded: '2026-04-15' },
      ];

      const result = computePpaClientMetrics(contacts, 'Test Client', 'loc-1', '2026-04-15');
      expect(result.appts_qualified).toBe(2);
      expect(result.amount_owed).toBe(200);
    });
  });

  describe('computeLeadBankRunway', () => {
    test('calculates runway from remaining and daily burn', () => {
      const result = computeLeadBankRunway(400000, 4500);
      expect(result.lead_bank_remaining).toBe(400000);
      expect(result.lead_bank_daily_burn).toBe(4500);
      expect(result.lead_bank_runway_days).toBe(88);
    });

    test('returns Infinity runway when burn is 0', () => {
      const result = computeLeadBankRunway(400000, 0);
      expect(result.lead_bank_runway_days).toBe(Infinity);
    });
  });
});
