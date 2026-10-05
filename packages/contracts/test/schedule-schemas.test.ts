import { describe, expect, it } from 'vitest';
import { ScheduleInput } from '../src/ads/schedule-schemas.js';

const validSchedule = {
  startsOn: '2026-10-05',
  endsOn: '2026-10-31',
  timeWindows: [
    { daysOfWeek: [1, 2, 3, 4, 5], localStartTime: '07:00', localEndTime: '09:00' },
    { daysOfWeek: [5], localStartTime: '22:00', localEndTime: '02:00' },
  ],
  gracePeriodMinutes: 10,
  engagementLimit: null,
};

function issuesOf(value: unknown) {
  const result = ScheduleInput.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code === 'custom' ? `custom:${(issue as { params?: { reason?: string } }).params?.reason}` : issue.code,
  }));
}

describe('schedule input', () => {
  it('accepts a normal schedule, including a window that runs past midnight', () => {
    expect(issuesOf(validSchedule)).toEqual([]);
    expect(issuesOf({ ...validSchedule, endsOn: validSchedule.startsOn, engagementLimit: 500, gracePeriodMinutes: 0 })).toEqual([]);
  });

  it.each([
    ['an end date before the start date', { ...validSchedule, endsOn: '2026-10-04' }, [{ path: 'endsOn', code: 'custom:end_before_start' }]],
    ['a date that does not exist', { ...validSchedule, startsOn: '2026-02-30' }, [{ path: 'startsOn', code: 'custom:date_does_not_exist' }]],
    ['a badly written date', { ...validSchedule, startsOn: '5/10/2026' }, [{ path: 'startsOn', code: 'invalid_format' }]],
    [
      'a window that starts and ends at the same time',
      { ...validSchedule, timeWindows: [{ daysOfWeek: [1], localStartTime: '08:00', localEndTime: '08:00' }] },
      [{ path: 'timeWindows.0.localEndTime', code: 'custom:window_start_equals_end' }],
    ],
    [
      'a day listed twice',
      { ...validSchedule, timeWindows: [{ daysOfWeek: [1, 1], localStartTime: '07:00', localEndTime: '09:00' }] },
      [{ path: 'timeWindows.0.daysOfWeek', code: 'custom:days_must_be_unique' }],
    ],
    [
      'a day that is not 1 to 7',
      { ...validSchedule, timeWindows: [{ daysOfWeek: [0], localStartTime: '07:00', localEndTime: '09:00' }] },
      [{ path: 'timeWindows.0.daysOfWeek.0', code: 'too_small' }],
    ],
    [
      'a time of 24:00',
      { ...validSchedule, timeWindows: [{ daysOfWeek: [1], localStartTime: '07:00', localEndTime: '24:00' }] },
      [{ path: 'timeWindows.0.localEndTime', code: 'invalid_format' }],
    ],
    ['no windows at all', { ...validSchedule, timeWindows: [] }, [{ path: 'timeWindows', code: 'too_small' }]],
    ['a grace period that is not offered', { ...validSchedule, gracePeriodMinutes: 15 }, [{ path: 'gracePeriodMinutes', code: 'invalid_union' }]],
    ['a tap limit of zero', { ...validSchedule, engagementLimit: 0 }, [{ path: 'engagementLimit', code: 'too_small' }]],
    ['an unknown field', { ...validSchedule, status: 'ACTIVE' }, [{ path: '', code: 'unrecognized_keys' }]],
  ])('refuses %s', (_description, schedule, expectedIssues) => {
    expect(issuesOf(schedule)).toEqual(expectedIssues);
  });
});
