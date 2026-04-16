const { SETTER_COMP, CLOSER_COMP, PPA_RATE, GHL_TAGS } = require('./config');

const CLOSED_STAGES = ['Closed trial', 'Closed PPA'];
const POST_SHOWED_STAGES = ['Closed trial', 'Closed PPA', 'Week 2 extension', 'Retainer upgrade', 'Website live', 'Churned'];

function countByStage(opportunities, stageMap, stageNames) {
  return opportunities.filter(o => {
    const stageName = stageMap[o.stageId];
    return stageNames.includes(stageName);
  }).length;
}

function computeSetterMetrics(opportunities, stageMap) {
  const closed_trial = countByStage(opportunities, stageMap, ['Closed trial']);
  const closed_ppa = countByStage(opportunities, stageMap, ['Closed PPA']);
  const calls_booked = countByStage(opportunities, stageMap, ['Call booked']);
  const calls_showed = countByStage(opportunities, stageMap, ['Call showed']);
  const week2_extensions = countByStage(opportunities, stageMap, ['Week 2 extension']);
  const retainer_upgrades = countByStage(opportunities, stageMap, ['Retainer upgrade']);

  // Total who showed = currently at showed + all who moved past showed
  const totalShowed = calls_showed + countByStage(opportunities, stageMap, POST_SHOWED_STAGES);
  const totalClosed = closed_trial + closed_ppa;
  const close_rate = totalShowed > 0 ? parseFloat(((totalClosed / totalShowed) * 100).toFixed(2)) : 0;

  const commission_owed =
    (closed_trial * SETTER_COMP.trial_close) +
    (closed_ppa * SETTER_COMP.ppa_close) +
    (week2_extensions * SETTER_COMP.second_week_close) +
    (retainer_upgrades * SETTER_COMP.retainer_upgrade);

  return {
    calls_booked,
    calls_showed,
    closed_trial,
    closed_ppa,
    week2_extensions,
    retainer_upgrades,
    close_rate,
    commission_owed,
  };
}

function computeCloserMetrics(opportunities, stageMap) {
  const retainer_closes = countByStage(opportunities, stageMap, ['Closed retainer']);
  const trial_closes = countByStage(opportunities, stageMap, ['Closed trial']);
  const builder_closes = countByStage(opportunities, stageMap, ['Closed builder']);
  const builder_downsell_closes = countByStage(opportunities, stageMap, ['Closed builder downsell']);
  const retainer_upgrades = countByStage(opportunities, stageMap, ['Retainer upgrade']);

  const totalShowed = countByStage(opportunities, stageMap, ['Call showed']) +
    retainer_closes + trial_closes + builder_closes + builder_downsell_closes + retainer_upgrades;
  const totalClosed = retainer_closes + trial_closes + builder_closes + builder_downsell_closes;
  const close_rate = totalShowed > 0 ? parseFloat(((totalClosed / totalShowed) * 100).toFixed(2)) : 0;

  const commission_owed =
    (retainer_closes * CLOSER_COMP.retainer_close) +
    (trial_closes * CLOSER_COMP.trial_close) +
    (builder_closes * CLOSER_COMP.builder_close) +
    (builder_downsell_closes * CLOSER_COMP.builder_downsell) +
    (retainer_upgrades * CLOSER_COMP.retainer_upgrade);

  return {
    retainer_closes,
    trial_closes,
    builder_closes,
    builder_downsell_closes,
    retainer_upgrades,
    close_rate,
    commission_owed,
  };
}

function computePpaClientMetrics(contacts, clientName, locationId, dateStr) {
  const qualified = contacts.filter(c =>
    (c.tags || []).includes(GHL_TAGS.qualified_appt)
  );

  return {
    client_name: clientName,
    location_id: locationId,
    date: dateStr,
    appts_qualified: qualified.length,
    amount_owed: qualified.length * PPA_RATE,
  };
}

function computeLeadBankRunway(remaining, dailyBurn) {
  return {
    lead_bank_remaining: remaining,
    lead_bank_daily_burn: dailyBurn,
    lead_bank_runway_days: dailyBurn > 0 ? Math.floor(remaining / dailyBurn) : Infinity,
  };
}

function computeAgencySnapshot(setterRows, closerRow, ppaRows, retainerClients, builderPipeline, leadBank) {
  const total_sms_sent = setterRows.reduce((sum, s) => sum + (s.sms_sent || 0), 0);
  const total_replies = setterRows.reduce((sum, s) => sum + (s.replies || 0), 0);
  const total_closes = setterRows.reduce((sum, s) => sum + (s.closed_trial || 0) + (s.closed_ppa || 0), 0) +
    (closerRow ? closerRow.retainer_closes + closerRow.trial_closes + closerRow.builder_closes + closerRow.builder_downsell_closes : 0);
  const total_ppa_revenue = ppaRows.reduce((sum, p) => sum + (p.amount_owed || 0), 0);
  const total_retainer_mrr = retainerClients
    .filter(r => r.status === 'active')
    .reduce((sum, r) => sum + (r.monthly_rate || 0), 0);
  const total_commission_owed = setterRows.reduce((sum, s) => sum + (s.commission_owed || 0), 0) +
    (closerRow ? closerRow.commission_owed : 0);
  const builder_pipeline_value = builderPipeline.reduce((sum, b) => sum + (b.revshare_projected || 0), 0);

  return {
    date: new Date().toISOString().split('T')[0],
    total_sms_sent,
    total_replies,
    total_closes,
    total_ppa_revenue,
    total_retainer_mrr,
    total_commission_owed,
    ...leadBank,
    builder_pipeline_value,
  };
}

module.exports = {
  computeSetterMetrics,
  computeCloserMetrics,
  computePpaClientMetrics,
  computeLeadBankRunway,
  computeAgencySnapshot,
};
