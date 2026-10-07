import { MAXIMUM_TIME_WINDOWS_PER_SCHEDULE } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { scheduleFixture } from '../../test/ad-fixtures';
import {
  addDays,
  draftFromSchedule,
  endsNextDay,
  isAllDay,
  isRealDate,
  newScheduleDraft,
  newTimeSlot,
  problemsFromApiFields,
  type ScheduleDraft,
  sameSchedule,
  slotsFromWindows,
  todayInTimeZone,
  validateSchedule,
  windowsFromSlots,
} from './schedule-draft';

const TODAY = '2026-10-06';

function draftWith(overrides: Partial<ScheduleDraft> = {}): ScheduleDraft {
  return { ...newScheduleDraft(TODAY), slots: [newTimeSlot({ days: [1, 2, 3, 4, 5], from: '07:00', to: '09:00' })], ...overrides };
}

describe('dates', () => {
  it('adds days by the calendar, across months, years and leap days', () => {
    expect(addDays('2026-10-06', 27)).toBe('2026-11-02');
    expect(addDays('2026-12-15', 27)).toBe('2027-01-11');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-10-06', -6)).toBe('2026-09-30');
  });

  it('knows a real date from one that only looks like one', () => {
    expect(isRealDate('2026-10-06')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2027-02-29')).toBe(false);
    expect(isRealDate('2026-13-01')).toBe(false);
    expect(isRealDate('2026-10-6')).toBe(false);
    expect(isRealDate('')).toBe(false);
  });

  it("says what day it is where the station is, which can be a day ahead of UTC: Lusaka is two hours ahead", () => {
    expect(todayInTimeZone('Africa/Lusaka', new Date('2026-10-06T21:59:00Z'))).toBe('2026-10-06');
    expect(todayInTimeZone('Africa/Lusaka', new Date('2026-10-06T22:00:00Z'))).toBe('2026-10-07');
    expect(todayInTimeZone('UTC', new Date('2026-10-06T22:00:00Z'))).toBe('2026-10-06');
  });

  it('falls back to the date in UTC for a time zone it does not know, rather than failing', () => {
    expect(todayInTimeZone('Not/AZone', new Date('2026-10-06T22:00:00Z'))).toBe('2026-10-06');
  });
});

describe('a new schedule', () => {
  it('runs from today for four weeks (28 days counting today), with ten minutes of grace, no tap limit and no times chosen', () => {
    expect(newScheduleDraft(TODAY)).toEqual({ startsOn: '2026-10-06', endsOn: '2026-11-02', slots: [], gracePeriodMinutes: 10, hasTapLimit: false, tapLimitText: '' });
  });

  it('starts a new time slot on weekdays from 07:00 to 09:00, so there is something to change', () => {
    expect(newTimeSlot()).toMatchObject({ days: [1, 2, 3, 4, 5], from: '07:00', to: '09:00' });
  });
});

describe('editing a saved schedule', () => {
  it('shows each window as a slot, with the dates, grace and tap limit as saved', () => {
    const saved = scheduleFixture({ gracePeriodMinutes: 5, engagementLimit: 250, startsOn: '2026-10-01', endsOn: '2026-10-31' });
    const draft = draftFromSchedule(saved);
    expect(draft).toMatchObject({ startsOn: '2026-10-01', endsOn: '2026-10-31', gracePeriodMinutes: 5, hasTapLimit: true, tapLimitText: '250' });
    expect(draft.slots).toHaveLength(1);
    expect(draft.slots[0]).toMatchObject({ days: [1, 2, 3, 4, 5], from: '07:00', to: '09:00' });
  });

  it('has no tap limit when none was saved', () => {
    expect(draftFromSchedule(scheduleFixture({ engagementLimit: null }))).toMatchObject({ hasTapLimit: false, tapLimitText: '' });
  });

  it('keeps a window that is not on the hour exactly as it is', () => {
    const slots = slotsFromWindows([{ daysOfWeek: [3, 1], localStartTime: '07:30', localEndTime: '08:45' }]);
    expect(slots[0]).toMatchObject({ days: [1, 3], from: '07:30', to: '08:45' });
  });
});

describe('time slots', () => {
  it('makes one window for a slot, with its days in order', () => {
    const { windows, slotKeys } = windowsFromSlots([newTimeSlot({ key: 'a', days: [5, 1, 3], from: '07:00', to: '09:00' })]);
    expect(windows).toEqual([{ daysOfWeek: [1, 3, 5], localStartTime: '07:00', localEndTime: '09:00' }]);
    expect(slotKeys).toEqual(['a']);
  });

  it('makes two windows for an all-day slot, because a window cannot start and end at the same time', () => {
    const { windows, slotKeys } = windowsFromSlots([newTimeSlot({ key: 'all', days: [6, 7], from: '00:00', to: '00:00' })]);
    expect(windows).toEqual([
      { daysOfWeek: [6, 7], localStartTime: '00:00', localEndTime: '12:00' },
      { daysOfWeek: [6, 7], localStartTime: '12:00', localEndTime: '00:00' },
    ]);
    expect(slotKeys).toEqual(['all', 'all']);
  });

  it('keeps a slot that runs into the next morning as one window', () => {
    const { windows } = windowsFromSlots([newTimeSlot({ days: [5], from: '22:00', to: '02:00' })]);
    expect(windows).toEqual([{ daysOfWeek: [5], localStartTime: '22:00', localEndTime: '02:00' }]);
  });

  it('leaves out a slot that cannot be a window yet: no days, or the end the same as the start', () => {
    const { windows } = windowsFromSlots([newTimeSlot({ days: [] }), newTimeSlot({ from: '07:00', to: '07:00' }), newTimeSlot({ days: [2], from: '10:00', to: '11:00' })]);
    expect(windows).toHaveLength(1);
  });

  it('knows an all-day slot, and one that ends the next morning', () => {
    expect(isAllDay({ from: '00:00', to: '00:00' })).toBe(true);
    expect(isAllDay({ from: '07:00', to: '07:00' })).toBe(false);
    expect(isAllDay({ from: '00:00', to: '06:00' })).toBe(false);
    expect(isAllDay({ from: '06:00', to: '00:00' })).toBe(false);
    expect(endsNextDay({ from: '22:00', to: '02:00' })).toBe(true);
    expect(endsNextDay({ from: '20:00', to: '00:00' })).toBe(false);
    expect(endsNextDay({ from: '07:00', to: '09:00' })).toBe(false);
  });
});

describe('checking a schedule', () => {
  describe('a good one', () => {
    it('makes exactly the input the API takes', () => {
      const validation = validateSchedule(draftWith({ gracePeriodMinutes: 5 }), TODAY);
      expect(validation.problemCount).toBe(0);
      expect(validation.input).toEqual({
        startsOn: '2026-10-06',
        endsOn: '2026-11-02',
        timeWindows: [{ daysOfWeek: [1, 2, 3, 4, 5], localStartTime: '07:00', localEndTime: '09:00' }],
        gracePeriodMinutes: 5,
        engagementLimit: null,
      });
    });

    it('includes the tap limit only when it is switched on', () => {
      expect(validateSchedule(draftWith({ hasTapLimit: true, tapLimitText: '500' }), TODAY).input?.engagementLimit).toBe(500);
      expect(validateSchedule(draftWith({ hasTapLimit: false, tapLimitText: '500' }), TODAY).input?.engagementLimit).toBeNull();
    });

    it('reads a tap limit written with a thousands separator', () => {
      expect(validateSchedule(draftWith({ hasTapLimit: true, tapLimitText: '1,000' }), TODAY).input?.engagementLimit).toBe(1000);
    });

    it('lets the last day be today, and the first day be in the past (an ad that has already started)', () => {
      expect(validateSchedule(draftWith({ startsOn: '2026-09-01', endsOn: TODAY }), TODAY).input).not.toBeNull();
    });

    it('lets a one-day schedule be the same day twice', () => {
      expect(validateSchedule(draftWith({ startsOn: TODAY, endsOn: TODAY }), TODAY).input).not.toBeNull();
    });

    it('accepts times that are not on the hour', () => {
      const validation = validateSchedule(draftWith({ slots: [newTimeSlot({ from: '07:30', to: '08:45' })] }), TODAY);
      expect(validation.input?.timeWindows[0]).toMatchObject({ localStartTime: '07:30', localEndTime: '08:45' });
    });
  });

  describe('what is wrong, in words', () => {
    it('asks for the dates when they are empty or not real', () => {
      const empty = validateSchedule(draftWith({ startsOn: '', endsOn: '' }), TODAY);
      expect(empty.problems.startsOn).toBe('Choose the first day.');
      expect(empty.problems.endsOn).toBe('Choose the last day.');
      const unreal = validateSchedule(draftWith({ startsOn: '2026-02-30', endsOn: '2026-13-01' }), TODAY);
      expect(unreal.problems.startsOn).toMatch(/doesn't exist/);
      expect(unreal.problems.endsOn).toMatch(/doesn't exist/);
    });

    it('will not let the last day come before the first', () => {
      const validation = validateSchedule(draftWith({ startsOn: '2026-10-20', endsOn: '2026-10-10' }), TODAY);
      expect(validation.problems.endsOn).toBe("The last day can't be before the first day.");
      expect(validation.input).toBeNull();
    });

    it('will not let the last day be one that has already passed', () => {
      const validation = validateSchedule(draftWith({ startsOn: '2026-09-01', endsOn: '2026-10-05' }), TODAY);
      expect(validation.problems.endsOn).toBe('That day has already passed. Choose today or a later day.');
    });

    it('asks for times when none are chosen', () => {
      const validation = validateSchedule(draftWith({ slots: [] }), TODAY);
      expect(validation.problems.times).toBe('Choose when this ad airs: at least one day and a time.');
      expect(validation.input).toBeNull();
    });

    it('says which slot has no days, and which has an end the same as its start', () => {
      const noDays = newTimeSlot({ key: 'no-days', days: [] });
      const same = newTimeSlot({ key: 'same', from: '07:00', to: '07:00' });
      const fine = newTimeSlot({ key: 'fine' });
      const validation = validateSchedule(draftWith({ slots: [noDays, same, fine] }), TODAY);
      expect(validation.problems.slots.get('no-days')).toEqual({ days: 'Choose at least one day.' });
      expect(validation.problems.slots.get('same')).toEqual({ end: "The end can't be the same as the start. To air all day, choose 00:00 to 00:00." });
      expect(validation.problems.slots.has('fine')).toBe(false);
    });

    it('does not call 00:00 to 00:00 a problem: it means all day', () => {
      const validation = validateSchedule(draftWith({ slots: [newTimeSlot({ from: '00:00', to: '00:00' })] }), TODAY);
      expect(validation.problemCount).toBe(0);
      expect(validation.input?.timeWindows).toHaveLength(2);
    });

    it('says when there are more separate time slots than an ad can have, and how many were asked for', () => {
      const slots = Array.from({ length: MAXIMUM_TIME_WINDOWS_PER_SCHEDULE + 1 }, (_unused, index) => newTimeSlot({ days: [(index % 7) + 1], from: `${String(index % 20).padStart(2, '0')}:00`, to: `${String((index % 20) + 1).padStart(2, '0')}:00` }));
      const distinct = slots.map((slot) => `${slot.days}-${slot.from}`);
      expect(new Set(distinct).size).toBe(slots.length);
      const validation = validateSchedule(draftWith({ slots }), TODAY);
      expect(validation.problems.times).toBe(`This needs 22 separate time slots, and an ad can have at most 21. Use the same hours on several days, or fewer separate hours.`);
      expect(validation.input).toBeNull();
    });

    it('allows exactly the most an ad can have', () => {
      const slots = Array.from({ length: MAXIMUM_TIME_WINDOWS_PER_SCHEDULE }, (_unused, index) => newTimeSlot({ days: [(index % 7) + 1], from: `${String(index % 20).padStart(2, '0')}:00`, to: `${String((index % 20) + 1).padStart(2, '0')}:00` }));
      expect(validateSchedule(draftWith({ slots }), TODAY).input).not.toBeNull();
    });

    it.each([
      ['', 'Enter how many taps, or turn the limit off.'],
      ['abc', 'Enter a whole number from 1 to 1,000,000.'],
      ['1.5', 'Enter a whole number from 1 to 1,000,000.'],
      ['-3', 'Enter a whole number from 1 to 1,000,000.'],
      ['0', 'Enter a whole number from 1 to 1,000,000.'],
      ['1000001', 'Enter a whole number from 1 to 1,000,000.'],
    ])('does not accept a tap limit of %j', (text, words) => {
      const validation = validateSchedule(draftWith({ hasTapLimit: true, tapLimitText: text }), TODAY);
      expect(validation.problems.tapLimit).toBe(words);
      expect(validation.input).toBeNull();
    });

    it('accepts the largest tap limit', () => {
      expect(validateSchedule(draftWith({ hasTapLimit: true, tapLimitText: '1000000' }), TODAY).input?.engagementLimit).toBe(1_000_000);
    });

    it('counts every problem, and still gives the windows for the preview', () => {
      const validation = validateSchedule(draftWith({ endsOn: '', slots: [newTimeSlot({ days: [] }), newTimeSlot({ days: [2], from: '10:00', to: '11:00' })], hasTapLimit: true, tapLimitText: 'x' }), TODAY);
      expect(validation.problemCount).toBe(3);
      expect(validation.windows).toHaveLength(1);
    });
  });
});

describe('whether a schedule has changed', () => {
  const saved = scheduleFixture({ startsOn: '2026-10-01', endsOn: '2026-10-31', gracePeriodMinutes: 10, engagementLimit: null });
  const unchanged = () => validateSchedule(draftFromSchedule(saved), '2026-10-01').input as NonNullable<ReturnType<typeof validateSchedule>['input']>;

  it('says no when nothing was changed', () => {
    expect(sameSchedule(unchanged(), saved)).toBe(true);
  });

  it('says no change when the same hours are written differently', () => {
    const input = unchanged();
    const split = { ...input, timeWindows: [{ daysOfWeek: [1, 2], localStartTime: '07:00', localEndTime: '09:00' }, { daysOfWeek: [3, 4, 5], localStartTime: '07:00', localEndTime: '08:00' }, { daysOfWeek: [3, 4, 5], localStartTime: '08:00', localEndTime: '09:00' }] };
    expect(sameSchedule(split, saved)).toBe(true);
  });

  it('says it changed when a date, the grace period, the tap limit or the hours differ', () => {
    const input = unchanged();
    expect(sameSchedule({ ...input, endsOn: '2026-11-01' }, saved)).toBe(false);
    expect(sameSchedule({ ...input, startsOn: '2026-10-02' }, saved)).toBe(false);
    expect(sameSchedule({ ...input, gracePeriodMinutes: 5 }, saved)).toBe(false);
    expect(sameSchedule({ ...input, engagementLimit: 100 }, saved)).toBe(false);
    expect(sameSchedule({ ...input, timeWindows: [{ daysOfWeek: [1, 2, 3, 4, 5], localStartTime: '07:00', localEndTime: '09:30' }] }, saved)).toBe(false);
  });

  it('says it changed when nothing is saved yet', () => {
    expect(sameSchedule(unchanged(), null)).toBe(false);
  });
});

describe('problems the API reports for a save', () => {
  const first = newTimeSlot({ key: 'first', days: [1], from: '07:00', to: '09:00' });
  const allDay = newTimeSlot({ key: 'all-day', days: [6], from: '00:00', to: '00:00' });
  const third = newTimeSlot({ key: 'third', days: [2], from: '10:00', to: '11:00' });
  const draft = draftWith({ slots: [first, allDay, third] });

  it('ties dates and the tap limit back to their boxes, in the same words as the checks here', () => {
    const problems = problemsFromApiFields(draft, [
      { path: 'startsOn', code: 'date_does_not_exist' },
      { path: 'endsOn', code: 'end_before_start' },
      { path: 'engagementLimit', code: 'too_big' },
    ]);
    expect(problems.startsOn).toMatch(/doesn't exist/);
    expect(problems.endsOn).toBe("The last day can't be before the first day.");
    expect(problems.tapLimit).toBe('Enter a whole number from 1 to 1,000,000.');
  });

  it('ties a window problem back to the slot that made the window, even after an all-day slot made two', () => {
    // Windows are: 0 = first, 1 and 2 = the two halves of the all-day slot, 3 = third.
    const problems = problemsFromApiFields(draft, [
      { path: 'timeWindows.3.localEndTime', code: 'window_start_equals_end' },
      { path: 'timeWindows.2.daysOfWeek', code: 'days_must_be_unique' },
    ]);
    expect(problems.slots.get('third')).toEqual({ end: "The end can't be the same as the start. To air all day, choose 00:00 to 00:00." });
    expect(problems.slots.get('all-day')).toEqual({ days: 'Each day can only be chosen once.' });
  });

  it('ignores paths it does not understand, and windows that are no longer there', () => {
    const problems = problemsFromApiFields(draft, [{ path: 'timeWindows.9.daysOfWeek', code: 'too_small' }, { path: 'nonsense', code: 'x' }, { path: '', code: 'custom' }]);
    expect(problems.slots.size).toBe(0);
    expect(problems.startsOn).toBeUndefined();
  });

  it('says when the API found too few or too many windows', () => {
    expect(problemsFromApiFields(draft, [{ path: 'timeWindows', code: 'too_small' }]).times).toBe('Choose when this ad airs: at least one day and a time.');
    expect(problemsFromApiFields(draft, [{ path: 'timeWindows', code: 'too_big' }]).times).toMatch(/at most 21/);
  });
});
