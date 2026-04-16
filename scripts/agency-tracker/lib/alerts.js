const { ALERT_THRESHOLDS } = require('./config');

function checkAlerts({ ppaClients, setterRows, closerRow, leadBank }) {
  const alerts = [];

  for (const client of ppaClients) {
    if (client.appts_qualified === 0 && client.days_since_launch >= ALERT_THRESHOLDS.zero_appts_days) {
      alerts.push({
        alert_type: 'zero_appts',
        severity: 'critical',
        message: `${client.client_name}: 0 qualified appts after ${client.days_since_launch} days`,
      });
    }
  }

  for (const setter of setterRows) {
    if (setter.close_rate < ALERT_THRESHOLDS.setter_low_close_pct && setter.close_rate > 0) {
      alerts.push({
        alert_type: 'low_close_rate',
        severity: 'warning',
        message: `${setter.setter_name}: ${setter.close_rate}% close rate (threshold: ${ALERT_THRESHOLDS.setter_low_close_pct}%)`,
      });
    }
  }

  if (closerRow && closerRow.close_rate < ALERT_THRESHOLDS.closer_low_close_pct && closerRow.close_rate > 0) {
    alerts.push({
      alert_type: 'closer_low_close_rate',
      severity: 'warning',
      message: `Tony: ${closerRow.close_rate}% close rate (threshold: ${ALERT_THRESHOLDS.closer_low_close_pct}%)`,
    });
  }

  if (leadBank.lead_bank_runway_days < ALERT_THRESHOLDS.lead_bank_runway_days) {
    alerts.push({
      alert_type: 'lead_bank_low',
      severity: 'critical',
      message: `Lead bank: ${leadBank.lead_bank_runway_days} days remaining (threshold: ${ALERT_THRESHOLDS.lead_bank_runway_days} days)`,
    });
  }

  return alerts;
}

module.exports = { checkAlerts };
