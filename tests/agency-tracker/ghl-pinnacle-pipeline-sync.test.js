const { buildSnapshotRow } = require('../../scripts/agency-tracker/ghl-pinnacle-pipeline-sync');

describe('ghl-pinnacle-pipeline-sync', () => {
  test('buildSnapshotRow maps a GHL opportunity to the snapshot row shape', () => {
    const opp = {
      id: 'opp_xyz',
      name: 'Robert Ahern',
      pipelineStageId: 'stage_abc',
      pipelineId: '3j5yy4pUlTNZcE9fDEez',
      monetaryValue: 500,
      source: 'fb_lead_form',
      createdAt: '2026-05-22T10:00:00Z',
      updatedAt: '2026-05-22T15:00:00Z',
      lastStageChangeAt: '2026-05-22T14:00:00Z',
    };
    const stageMap = { stage_abc: 'Clarity Call Scheduled' };
    const row = buildSnapshotRow(opp, stageMap);

    expect(row.opp_id).toBe('opp_xyz');
    expect(row.name).toBe('Robert Ahern');
    expect(row.stage_id).toBe('stage_abc');
    expect(row.stage_name).toBe('Clarity Call Scheduled');
    expect(row.pipeline_id).toBe('3j5yy4pUlTNZcE9fDEez');
    expect(row.source).toBe('fb_lead_form');
    expect(row.monetary_value).toBe(500);
    expect(row.created_at).toBe('2026-05-22T10:00:00Z');
    expect(row.last_activity_at).toBe('2026-05-22T14:00:00Z'); // lastStageChangeAt preferred
    expect(row.raw_json).toEqual(opp);
  });

  test('buildSnapshotRow handles missing fields gracefully', () => {
    const opp = { id: 'opp_y', name: '', pipelineStageId: 'unknown' };
    const row = buildSnapshotRow(opp, {});
    expect(row.opp_id).toBe('opp_y');
    expect(row.stage_name).toBeNull();
    expect(row.monetary_value).toBeNull();
  });

  test('buildSnapshotRow falls back to legacy stageId field for backward compat', () => {
    const opp = { id: 'opp_z', name: 'X', stageId: 'legacy_stage' };
    const row = buildSnapshotRow(opp, { legacy_stage: 'Old Stage' });
    expect(row.stage_id).toBe('legacy_stage');
    expect(row.stage_name).toBe('Old Stage');
  });
});
