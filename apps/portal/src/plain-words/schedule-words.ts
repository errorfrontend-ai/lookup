import { MAXIMUM_ENGAGEMENT_LIMIT, MAXIMUM_TIME_WINDOWS_PER_SCHEDULE } from '@lookup/contracts';

/** The parts of a schedule a problem can be about. */
export type ScheduleField = 'startsOn' | 'endsOn' | 'slotDays' | 'slotEnd' | 'tapLimit';

export const NO_TIMES_PROBLEM = 'Choose when this ad airs: at least one day and a time.';
export const SCHEDULE_NOT_SAVABLE_PROBLEM = "These times can't be saved as they are. Check each one.";

export function tooManyTimeSlotsProblem(count: number): string {
  return `This needs ${count} separate time slots, and an ad can have at most ${MAXIMUM_TIME_WINDOWS_PER_SCHEDULE}. Use the same hours on several days, or fewer separate hours.`;
}

const PROBLEM_WORDS: Record<ScheduleField, Record<string, string>> = {
  startsOn: {
    empty: 'Choose the first day.',
    date_does_not_exist: "That date doesn't exist. Choose the first day again.",
    invalid_format: "That date doesn't look right. Choose the first day again.",
  },
  endsOn: {
    empty: 'Choose the last day.',
    date_does_not_exist: "That date doesn't exist. Choose the last day again.",
    invalid_format: "That date doesn't look right. Choose the last day again.",
    end_before_start: "The last day can't be before the first day.",
    already_passed: 'That day has already passed. Choose today or a later day.',
  },
  slotDays: {
    empty: 'Choose at least one day.',
    too_small: 'Choose at least one day.',
    days_must_be_unique: 'Each day can only be chosen once.',
  },
  slotEnd: {
    same_time: "The end can't be the same as the start. To air all day, choose 00:00 to 00:00.",
    window_start_equals_end: "The end can't be the same as the start. To air all day, choose 00:00 to 00:00.",
    invalid_format: 'Choose a time of day.',
  },
  tapLimit: {
    empty: 'Enter how many taps, or turn the limit off.',
    not_a_number: `Enter a whole number from 1 to ${MAXIMUM_ENGAGEMENT_LIMIT.toLocaleString('en-US')}.`,
    too_small: `Enter a whole number from 1 to ${MAXIMUM_ENGAGEMENT_LIMIT.toLocaleString('en-US')}.`,
    too_big: `Enter a whole number from 1 to ${MAXIMUM_ENGAGEMENT_LIMIT.toLocaleString('en-US')}.`,
  },
};

export function describeScheduleProblem(field: ScheduleField, code: string): string {
  return PROBLEM_WORDS[field][code] ?? 'Check this one.';
}

/** The grace period choices in words. */
export function describeGraceOption(minutes: number): string {
  return minutes === 0 ? 'None: only during the slot' : `${minutes} minutes after the slot ends`;
}
