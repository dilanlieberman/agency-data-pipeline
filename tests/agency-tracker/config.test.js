const config = require('../../scripts/agency-tracker/lib/config');

describe('agency-tracker config', () => {
  describe('SETTERS', () => {
    it('should map cesar to correct location ID', () => {
      expect(config.SETTERS.cesar.locationId).toBe('waStZftBf5D40prioYoj');
    });

    it('should map cesar to correct name', () => {
      expect(config.SETTERS.cesar.name).toBe('cesar sub acc 1');
    });

    it('should map cole to correct location ID', () => {
      expect(config.SETTERS.cole.locationId).toBe('o35tMRm72poYzDndLy87');
    });

    it('should map cole to correct name', () => {
      expect(config.SETTERS.cole.name).toBe('coleton sub acc 1');
    });

    it('should map sofie to correct location ID', () => {
      expect(config.SETTERS.sofie.locationId).toBe('3iyaLi4IT7AqbT2b1VZN');
    });

    it('should map sofie to correct name', () => {
      expect(config.SETTERS.sofie.name).toBe('tony sub acc 2');
    });
  });

  describe('CLOSER', () => {
    it('should map tony with paidAdsLocationId', () => {
      expect(config.CLOSER.tony.paidAdsLocationId).toBe('IpuSv4jgeeoI0hS1Ib7e');
    });

    it('should map tony with builderLocationId', () => {
      expect(config.CLOSER.tony.builderLocationId).toBe('bA26aysHNm0ItD2Dieuo');
    });

    it('should map tony to name "Tony Salada"', () => {
      expect(config.CLOSER.tony.name).toBe('Tony Salada');
    });
  });

  describe('SETTER_COMP', () => {
    it('should have ppa_close = 250', () => {
      expect(config.SETTER_COMP.ppa_close).toBe(250);
    });

    it('should have trial_close = 250', () => {
      expect(config.SETTER_COMP.trial_close).toBe(250);
    });

    it('should have second_week_close = 250', () => {
      expect(config.SETTER_COMP.second_week_close).toBe(250);
    });

    it('should have retainer_upgrade = 250', () => {
      expect(config.SETTER_COMP.retainer_upgrade).toBe(250);
    });

    it('should have mrr_per_retainer = 75', () => {
      expect(config.SETTER_COMP.mrr_per_retainer).toBe(75);
    });
  });

  describe('CLOSER_COMP', () => {
    it('should have retainer_close = 750', () => {
      expect(config.CLOSER_COMP.retainer_close).toBe(750);
    });

    it('should have trial_close = 250', () => {
      expect(config.CLOSER_COMP.trial_close).toBe(250);
    });

    it('should have builder_close = 750', () => {
      expect(config.CLOSER_COMP.builder_close).toBe(750);
    });

    it('should have builder_downsell = 500', () => {
      expect(config.CLOSER_COMP.builder_downsell).toBe(500);
    });

    it('should have retainer_upgrade = 750', () => {
      expect(config.CLOSER_COMP.retainer_upgrade).toBe(750);
    });
  });

  describe('ALERT_THRESHOLDS', () => {
    it('should have zero_appts_days = 3', () => {
      expect(config.ALERT_THRESHOLDS.zero_appts_days).toBe(3);
    });

    it('should have setter_low_close_pct = 20', () => {
      expect(config.ALERT_THRESHOLDS.setter_low_close_pct).toBe(20);
    });

    it('should have setter_low_close_weeks = 2', () => {
      expect(config.ALERT_THRESHOLDS.setter_low_close_weeks).toBe(2);
    });

    it('should have closer_low_close_pct = 30', () => {
      expect(config.ALERT_THRESHOLDS.closer_low_close_pct).toBe(30);
    });

    it('should have lead_bank_runway_days = 60', () => {
      expect(config.ALERT_THRESHOLDS.lead_bank_runway_days).toBe(60);
    });

    it('should have reply_rate_drop_pct = 30', () => {
      expect(config.ALERT_THRESHOLDS.reply_rate_drop_pct).toBe(30);
    });
  });

  describe('GHL_TAGS', () => {
    it('should map qualified_appt tag', () => {
      expect(config.GHL_TAGS.qualified_appt).toBe('qualified_appt');
    });

    it('should map website_live tag', () => {
      expect(config.GHL_TAGS.website_live).toBe('website_live');
    });

    it('should map seo_active tag', () => {
      expect(config.GHL_TAGS.seo_active).toBe('seo_active');
    });

    it('should map retainer_upgrade tag', () => {
      expect(config.GHL_TAGS.retainer_upgrade).toBe('retainer_upgrade');
    });

    it('should map builder_foundations tag', () => {
      expect(config.GHL_TAGS.builder_foundations).toBe('builder_foundations');
    });

    it('should map ach_active tag', () => {
      expect(config.GHL_TAGS.ach_active).toBe('ach_active');
    });
  });

  describe('constants', () => {
    it('should have PPA_RATE = 100', () => {
      expect(config.PPA_RATE).toBe(100);
    });

    it('should have GHL_BASE pointing to services.leadconnectorhq.com', () => {
      expect(config.GHL_BASE).toBe('https://services.leadconnectorhq.com');
    });

    it('should have GHL_VERSION set to 2021-07-28', () => {
      expect(config.GHL_VERSION).toBe('2021-07-28');
    });
  });

  describe('PIPELINE_STAGES', () => {
    it('should have exactly 10 stages', () => {
      expect(config.PIPELINE_STAGES.length).toBe(10);
    });

    it('should have correct stages in order', () => {
      const expected = [
        'SMS sent',
        'Reply received',
        'Call booked',
        'Call showed',
        'Closed trial',
        'Closed PPA',
        'Week 2 extension',
        'Retainer upgrade',
        'Website live',
        'Churned',
      ];
      expect(config.PIPELINE_STAGES).toEqual(expected);
    });
  });

  describe('BUILDER_STAGES', () => {
    it('should have exactly 7 stages', () => {
      expect(config.BUILDER_STAGES.length).toBe(7);
    });

    it('should have correct stages in order', () => {
      const expected = [
        'inquiry',
        'discovery',
        'plot_review',
        'proposal',
        'contract',
        'foundations',
        'paid',
      ];
      expect(config.BUILDER_STAGES).toEqual(expected);
    });
  });

  describe('loadTokens()', () => {
    it('should load tokens from sub-account-tokens.json', () => {
      const tokens = config.loadTokens();
      expect(tokens).toBeDefined();
      expect(typeof tokens).toBe('object');
    });

    it('should load cesar token', () => {
      const tokens = config.loadTokens();
      expect(tokens['waStZftBf5D40prioYoj']).toBeDefined();
      expect(tokens['waStZftBf5D40prioYoj'].token).toBe('pit-REDACTED');
    });

    it('should load cole token', () => {
      const tokens = config.loadTokens();
      expect(tokens['o35tMRm72poYzDndLy87']).toBeDefined();
      expect(tokens['o35tMRm72poYzDndLy87'].token).toBe('pit-REDACTED');
    });

    it('should load sofie/tony token', () => {
      const tokens = config.loadTokens();
      expect(tokens['3iyaLi4IT7AqbT2b1VZN']).toBeDefined();
      expect(tokens['3iyaLi4IT7AqbT2b1VZN'].token).toBe('pit-REDACTED');
    });
  });

  describe('getToken()', () => {
    it('should return token string for valid location ID', () => {
      const token = config.getToken('waStZftBf5D40prioYoj');
      expect(token).toBe('pit-REDACTED');
    });

    it('should return token for cole location', () => {
      const token = config.getToken('o35tMRm72poYzDndLy87');
      expect(token).toBe('pit-REDACTED');
    });

    it('should return token for sofie/tony location', () => {
      const token = config.getToken('3iyaLi4IT7AqbT2b1VZN');
      expect(token).toBe('pit-REDACTED');
    });

    it('should throw if location ID not found', () => {
      expect(() => config.getToken('invalid-location-id')).toThrow();
    });

    it('should throw with descriptive error message', () => {
      expect(() => config.getToken('invalid-location-id')).toThrow(/not found/i);
    });
  });
});
