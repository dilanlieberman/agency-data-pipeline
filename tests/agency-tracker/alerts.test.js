const { checkAlerts } = require('../../scripts/agency-tracker/lib/alerts');

describe('alerts', () => {
  test('flags client with 0 appts after 3 days', () => {
    const ppaClients = [
      { client_name: 'Acme', appts_qualified: 0, days_since_launch: 4 },
      { client_name: 'Beta', appts_qualified: 2, days_since_launch: 1 },
    ];

    const alerts = checkAlerts({ ppaClients, setterRows: [], closerRow: null, leadBank: { lead_bank_runway_days: 100 } });
    const zeroAppt = alerts.find(a => a.alert_type === 'zero_appts');
    expect(zeroAppt).toBeDefined();
    expect(zeroAppt.message).toContain('Acme');
    expect(zeroAppt.severity).toBe('critical');
  });

  test('flags setter below 20% close rate', () => {
    const setterRows = [
      { setter_name: 'cesar', close_rate: 15 },
      { setter_name: 'cole', close_rate: 35 },
    ];

    const alerts = checkAlerts({ ppaClients: [], setterRows, closerRow: null, leadBank: { lead_bank_runway_days: 100 } });
    const lowClose = alerts.find(a => a.alert_type === 'low_close_rate' && a.message.includes('cesar'));
    expect(lowClose).toBeDefined();
    expect(lowClose.severity).toBe('warning');
  });

  test('flags Tony below 30% close rate', () => {
    const closerRow = { close_rate: 25 };

    const alerts = checkAlerts({ ppaClients: [], setterRows: [], closerRow, leadBank: { lead_bank_runway_days: 100 } });
    const lowClose = alerts.find(a => a.alert_type === 'closer_low_close_rate');
    expect(lowClose).toBeDefined();
    expect(lowClose.message).toContain('Tony');
  });

  test('flags lead bank below 60 days', () => {
    const leadBank = { lead_bank_remaining: 50000, lead_bank_daily_burn: 4500, lead_bank_runway_days: 11 };

    const alerts = checkAlerts({ ppaClients: [], setterRows: [], closerRow: null, leadBank });
    const bankLow = alerts.find(a => a.alert_type === 'lead_bank_low');
    expect(bankLow).toBeDefined();
    expect(bankLow.severity).toBe('critical');
  });

  test('returns empty array when everything is healthy', () => {
    const alerts = checkAlerts({
      ppaClients: [{ client_name: 'Good', appts_qualified: 5, days_since_launch: 2 }],
      setterRows: [{ setter_name: 'cesar', close_rate: 35 }],
      closerRow: { close_rate: 40 },
      leadBank: { lead_bank_runway_days: 100 },
    });
    expect(alerts).toEqual([]);
  });
});
