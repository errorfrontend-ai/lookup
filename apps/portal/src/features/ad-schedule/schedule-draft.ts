import { type AdSchedule, DEFAULT_GRACE_PERIOD_MINUTES, MAXIMUM_ENGAGEMENT_LIMIT, MAXIMUM_TIME_WINDOWS_PER_SCHEDULE, ScheduleInput } from '@lookup/contracts';
import type { FieldProblem } from '../../api/api-client';
import {
  describeScheduleProblem,
  NO_TIMES_PROBLEM,
  SCHEDULE_NOT_SAVABLE_PROBLEM,
  type ScheduleField,
  tooManyTimeSlotsProblem,
} from '../../plain-words/schedule-words';
import { sameCoverage, type TimeWindow } from './schedule-conversion';

/** How long a new schedule runs by default: four weeks, counting the first day. */
export const DEFAULT_SCHEDULE_DAYS = 28;

/** One row of the list of times: some days, and from when to when. A `to` before the `from` runs into the next morning. */
export interface TimeSlot {
  key: string;
  /** ISO days: 1 = Monday … 7 = Sunday. */
  days: number[];
  from: string;
  to: string;
}

/** A schedule as it is being edited: what was chosen and typed, before it is checked. */
export interface ScheduleDraft {
  /** Station-local "YYYY-MM-DD". Empty while the box is empty. */
  startsOn: string;
  endsOn: string;
  slots: TimeSlot[];
  gracePeriodMinutes: number;
  hasTapLimit: boolean;
  tapLimitText: string;
}

const REAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function isRealDate(date: string): boolean {
  const match = REAL_DATE.exec(date);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const asDate = new Date(Date.UTC(year, month - 1, day));
  return asDate.getUTCFullYear() === year && asDate.getUTCMonth() === month - 1 && asDate.getUTCDate() === day;
}

/** A calendar date some days later (or earlier), as "YYYY-MM-DD". Plain calendar arithmetic: no time zone can shift it. */
export function addDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Today's date where the station is ("YYYY-MM-DD"), which can differ from the date on the computer in use. */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function newTimeSlot(overrides: Partial<TimeSlot> = {}): TimeSlot {
  return { key: crypto.randomUUID(), days: [1, 2, 3, 4, 5], from: '07:00', to: '09:00', ...overrides };
}

/** A new schedule: from today for four weeks, no times chosen yet. */
export function newScheduleDraft(today: string): ScheduleDraft {
  return { startsOn: today, endsOn: addDays(today, DEFAULT_SCHEDULE_DAYS - 1), slots: [], gracePeriodMinutes: DEFAULT_GRACE_PERIOD_MINUTES, hasTapLimit: false, tapLimitText: '' };
}

export function slotsFromWindows(windows: readonly TimeWindow[]): TimeSlot[] {
  return windows.map((window) => newTimeSlot({ days: [...window.daysOfWeek].sort((first, second) => first - second), from: window.localStartTime, to: window.localEndTime }));
}

export function draftFromSchedule(schedule: AdSchedule): ScheduleDraft {
  return {
    startsOn: schedule.startsOn,
    endsOn: schedule.endsOn,
    slots: slotsFromWindows(schedule.timeWindows),
    gracePeriodMinutes: schedule.gracePeriodMinutes,
    hasTapLimit: schedule.engagementLimit !== null,
    tapLimitText: schedule.engagementLimit === null ? '' : String(schedule.engagementLimit),
  };
}

/** Whether a slot is "all day": starting and ending at midnight, which a window cannot say in one piece. */
export function isAllDay(slot: Pick<TimeSlot, 'from' | 'to'>): boolean {
  return slot.from === '00:00' && slot.to === '00:00';
}

/** Whether a slot ends the next morning (its end is before its start, and it is not "all day"). */
export function endsNextDay(slot: Pick<TimeSlot, 'from' | 'to'>): boolean {
  return slot.to < slot.from && slot.to !== '00:00';
}

/**
 * The windows for a list of slots, and which slot each window came from (an "all day" slot makes two).
 * A slot that cannot make a window yet (no days, or the end the same as the start) makes none.
 */
export function windowsFromSlots(slots: readonly TimeSlot[]): { windows: TimeWindow[]; slotKeys: string[] } {
  const windows: TimeWindow[] = [];
  const slotKeys: string[] = [];
  for (const slot of slots) {
    if (slot.days.length === 0 || !TIME_OF_DAY.test(slot.from) || !TIME_OF_DAY.test(slot.to)) continue;
    const daysOfWeek = [...slot.days].sort((first, second) => first - second);
    const add = (localStartTime: string, localEndTime: string) => {
      windows.push({ daysOfWeek, localStartTime, localEndTime });
      slotKeys.push(slot.key);
    };
    if (isAllDay(slot)) {
      add('00:00', '12:00');
      add('12:00', '00:00');
    } else if (slot.from !== slot.to) {
      add(slot.from, slot.to);
    }
  }
  return { windows, slotKeys };
}

export interface SlotProblems {
  days?: string;
  end?: string;
}

export interface ScheduleProblems {
  startsOn?: string;
  endsOn?: string;
  /** About the times as a whole: none chosen, or too many separate ones. */
  times?: string;
  tapLimit?: string;
  slots: ReadonlyMap<string, SlotProblems>;
}

export interface ScheduleValidation {
  /** What to save: set only when everything is right. */
  input: ScheduleInput | null;
  problems: ScheduleProblems;
  /** The windows the slots make, for the preview; also set while something else is wrong. */
  windows: TimeWindow[];
  problemCount: number;
}

function readTapLimit(text: string): { value: number } | { code: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { code: 'empty' };
  if (!/^\d[\d,\s]*$/.test(trimmed)) return { code: 'not_a_number' };
  const value = Number(trimmed.replace(/[,\s]/g, ''));
  if (value < 1) return { code: 'too_small' };
  if (value > MAXIMUM_ENGAGEMENT_LIMIT) return { code: 'too_big' };
  return { value };
}

/** Checks a schedule and says, in words, what is wrong; the input is set only when nothing is. `today` is the station's date. */
export function validateSchedule(draft: ScheduleDraft, today: string): ScheduleValidation {
  const slotProblems = new Map<string, SlotProblems>();
  const problems: { startsOn?: string; endsOn?: string; times?: string; tapLimit?: string } = {};

  if (draft.startsOn === '') problems.startsOn = describeScheduleProblem('startsOn', 'empty');
  else if (!isRealDate(draft.startsOn)) problems.startsOn = describeScheduleProblem('startsOn', 'date_does_not_exist');
  if (draft.endsOn === '') problems.endsOn = describeScheduleProblem('endsOn', 'empty');
  else if (!isRealDate(draft.endsOn)) problems.endsOn = describeScheduleProblem('endsOn', 'date_does_not_exist');
  else if (!problems.startsOn && draft.endsOn < draft.startsOn) problems.endsOn = describeScheduleProblem('endsOn', 'end_before_start');
  else if (draft.endsOn < today) problems.endsOn = describeScheduleProblem('endsOn', 'already_passed');

  for (const slot of draft.slots) {
    const found: SlotProblems = {};
    if (slot.days.length === 0) found.days = describeScheduleProblem('slotDays', 'empty');
    if (slot.from === slot.to && !isAllDay(slot)) found.end = describeScheduleProblem('slotEnd', 'same_time');
    if (Object.keys(found).length > 0) slotProblems.set(slot.key, found);
  }

  const { windows } = windowsFromSlots(draft.slots);
  if (draft.slots.length === 0) problems.times = NO_TIMES_PROBLEM;
  else if (windows.length > MAXIMUM_TIME_WINDOWS_PER_SCHEDULE) problems.times = tooManyTimeSlotsProblem(windows.length);

  let engagementLimit: number | null = null;
  if (draft.hasTapLimit) {
    const reading = readTapLimit(draft.tapLimitText);
    if ('value' in reading) engagementLimit = reading.value;
    else problems.tapLimit = describeScheduleProblem('tapLimit', reading.code);
  }

  const problemCount = Object.keys(problems).length + [...slotProblems.values()].reduce((count, found) => count + Object.keys(found).length, 0);
  let input: ScheduleInput | null = null;
  if (problemCount === 0) {
    const parsed = ScheduleInput.safeParse({ startsOn: draft.startsOn, endsOn: draft.endsOn, timeWindows: windows, gracePeriodMinutes: draft.gracePeriodMinutes, engagementLimit });
    if (parsed.success) input = parsed.data;
    else problems.times = SCHEDULE_NOT_SAVABLE_PROBLEM;
  }
  return { input, problems: { ...problems, slots: slotProblems }, windows, problemCount: input ? 0 : Math.max(problemCount, 1) };
}

/** Whether the saved schedule already says what the input says: the same dates, grace, tap limit and minutes on air. */
export function sameSchedule(input: ScheduleInput, saved: AdSchedule | null): boolean {
  return (
    saved !== null &&
    saved.startsOn === input.startsOn &&
    saved.endsOn === input.endsOn &&
    saved.gracePeriodMinutes === input.gracePeriodMinutes &&
    saved.engagementLimit === input.engagementLimit &&
    sameCoverage(saved.timeWindows, input.timeWindows)
  );
}

/**
 * The problems the API reported for a save, tied back to the parts of the schedule they are about.
 * Window problems are matched to the slot that made the window.
 */
export function problemsFromApiFields(draft: ScheduleDraft, fields: readonly FieldProblem[]): ScheduleProblems {
  const { slotKeys } = windowsFromSlots(draft.slots);
  const found: { startsOn?: string; endsOn?: string; times?: string; tapLimit?: string } = {};
  const slots = new Map<string, SlotProblems>();
  for (const { path, code } of fields) {
    const windowMatch = /^timeWindows\.(\d+)\.(daysOfWeek|localEndTime|localStartTime)$/.exec(path);
    if (path === 'startsOn') found.startsOn = describeScheduleProblem('startsOn', code);
    else if (path === 'endsOn') found.endsOn = describeScheduleProblem('endsOn', code);
    else if (path === 'engagementLimit') found.tapLimit = describeScheduleProblem('tapLimit', code === 'too_small' || code === 'too_big' ? code : 'not_a_number');
    else if (path === 'timeWindows') found.times = code === 'too_small' ? NO_TIMES_PROBLEM : tooManyTimeSlotsProblem(windowsFromSlots(draft.slots).windows.length);
    else if (windowMatch) {
      const key = slotKeys[Number(windowMatch[1])];
      if (!key) continue;
      const isDays = windowMatch[2] === 'daysOfWeek';
      slots.set(key, { ...slots.get(key), ...(isDays ? { days: describeScheduleProblem('slotDays', code) } : { end: describeScheduleProblem('slotEnd', code) }) });
    }
  }
  return { ...found, slots };
}
