import { describe, expect, it } from 'vitest';
import { actionCardFixture, scheduleFixture } from '../../test/ad-fixtures';
import { blockersFromApiFields, findPublishBlockers } from './find-publish-blockers';

const TODAY = '2026-10-06';
const ready = { status: 'PROCESSING' as const, actionCard: actionCardFixture(), schedule: scheduleFixture({ startsOn: '2026-10-01', endsOn: '2026-10-31' }) };

describe('what stops an ad being published', () => {
  it('is nothing when the audio is in, there are buttons, and the times have not ended', () => {
    expect(findPublishBlockers(ready, TODAY)).toEqual([]);
  });

  it.each(['PROCESSING', 'READY', 'NEEDS_REVIEW'] as const)('accepts audio that is %s', (status) => {
    expect(findPublishBlockers({ ...ready, status }, TODAY)).toEqual([]);
  });

  it.each(['AWAITING_UPLOAD', 'FAILED'] as const)('names audio that is %s', (status) => {
    expect(findPublishBlockers({ ...ready, status }, TODAY)).toEqual(['upload_not_verified']);
  });

  it('names missing buttons', () => {
    expect(findPublishBlockers({ ...ready, actionCard: null }, TODAY)).toEqual(['action_card_missing']);
  });

  it('names a missing schedule, and a schedule with no times', () => {
    expect(findPublishBlockers({ ...ready, schedule: null }, TODAY)).toEqual(['schedule_missing']);
    expect(findPublishBlockers({ ...ready, schedule: scheduleFixture({ timeWindows: [] }) }, TODAY)).toEqual(['schedule_missing']);
  });

  it('counts the last day until it is over: today is fine, yesterday is not', () => {
    expect(findPublishBlockers({ ...ready, schedule: scheduleFixture({ endsOn: TODAY }) }, TODAY)).toEqual([]);
    expect(findPublishBlockers({ ...ready, schedule: scheduleFixture({ endsOn: '2026-10-05' }) }, TODAY)).toEqual(['schedule_already_ended']);
  });

  it('lists everything in the order the API checks it', () => {
    expect(findPublishBlockers({ status: 'FAILED', actionCard: null, schedule: null }, TODAY)).toEqual(['upload_not_verified', 'action_card_missing', 'schedule_missing']);
    expect(findPublishBlockers({ status: 'AWAITING_UPLOAD', actionCard: null, schedule: scheduleFixture({ endsOn: '2026-09-01' }) }, TODAY)).toEqual(['upload_not_verified', 'action_card_missing', 'schedule_already_ended']);
  });
});

describe('the blockers named in an API refusal', () => {
  it('are taken in a fixed order, whatever order they came in', () => {
    expect(blockersFromApiFields([{ code: 'schedule_missing' }, { code: 'upload_not_verified' }])).toEqual(['upload_not_verified', 'schedule_missing']);
  });

  it('ignore anything this page does not know', () => {
    expect(blockersFromApiFields([{ code: 'something_new' }, { code: 'action_card_missing' }])).toEqual(['action_card_missing']);
    expect(blockersFromApiFields([])).toEqual([]);
  });
});
