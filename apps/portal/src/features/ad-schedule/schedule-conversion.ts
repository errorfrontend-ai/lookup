/**
 * Two ways of writing the same weekly schedule, and the way between them.
 *
 * The API stores a schedule as time windows: some days, a start time and an end time (an end before the
 * start runs past midnight and belongs to the day it starts on; "00:00" as an end is midnight). People
 * edit it as a grid of hours, a row per day. Converting must never change which minutes are on air, so
 * everything here is checked against `coverageOf`, the minutes of the week a set of windows covers.
 */

export const MINUTES_PER_DAY = 24 * 60;
export const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** `grid[dayIndex][hour]`, Monday first (dayIndex 0 is ISO day 1). True when that whole hour is on air. */
export type WeekGrid = boolean[][];

export interface TimeWindow {
  /** ISO days: 1 = Monday … 7 = Sunday. */
  daysOfWeek: number[];
  /** "HH:MM" in the station's time zone. */
  localStartTime: string;
  localEndTime: string;
}

export function emptyGrid(): WeekGrid {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => false));
}

function minutesOf(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function timeOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Which minutes of the week the windows cover: index = (ISO day - 1) * 1440 + minute of that day. A
 * window that ends at or before its start covers the rest of its day and the early part of the next
 * (Sunday's runs into Monday). A window with no length covers nothing.
 */
export function coverageOf(windows: readonly TimeWindow[]): boolean[] {
  const covered = Array.from({ length: MINUTES_PER_WEEK }, () => false);
  const mark = (from: number, to: number) => {
    for (let minute = from; minute < to; minute += 1) covered[minute % MINUTES_PER_WEEK] = true;
  };
  for (const timeWindow of windows) {
    const start = minutesOf(timeWindow.localStartTime);
    const end = minutesOf(timeWindow.localEndTime);
    if (end === start) continue;
    for (const isoDay of timeWindow.daysOfWeek) {
      const dayStart = (isoDay - 1) * MINUTES_PER_DAY;
      if (end > start) mark(dayStart + start, dayStart + end);
      else {
        mark(dayStart + start, dayStart + MINUTES_PER_DAY);
        mark(dayStart + MINUTES_PER_DAY, dayStart + MINUTES_PER_DAY + end);
      }
    }
  }
  return covered;
}

/** Whether two sets of windows put exactly the same minutes of the week on air, however they are written. */
export function sameCoverage(first: readonly TimeWindow[], second: readonly TimeWindow[]): boolean {
  const firstCoverage = coverageOf(first);
  const secondCoverage = coverageOf(second);
  return firstCoverage.every((isCovered, minute) => isCovered === secondCoverage[minute]);
}

/**
 * The hour grid for a set of windows. When some window starts or ends off the hour the grid could only
 * show it wrongly (by rounding), so there is no grid: the schedule must be edited as a list of times.
 */
export function gridFromWindows(windows: readonly TimeWindow[]): { isOnTheHour: true; grid: WeekGrid } | { isOnTheHour: false; grid: null } {
  const covered = coverageOf(windows);
  const grid = emptyGrid();
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const firstMinute = dayIndex * MINUTES_PER_DAY + hour * 60;
      const minutesOn = covered.slice(firstMinute, firstMinute + 60).filter(Boolean).length;
      if (minutesOn !== 0 && minutesOn !== 60) return { isOnTheHour: false, grid: null };
      (grid[dayIndex] as boolean[])[hour] = minutesOn === 60;
    }
  }
  return { isOnTheHour: true, grid };
}

interface HourRun {
  /** The first hour on air. */
  start: number;
  /** One past the last hour on air (24 when the run reaches midnight). */
  end: number;
}

function runsOf(hours: readonly boolean[]): HourRun[] {
  const runs: HourRun[] = [];
  let start = -1;
  for (let hour = 0; hour <= 24; hour += 1) {
    const isOn = hour < 24 && hours[hour] === true;
    if (isOn && start < 0) start = hour;
    if (!isOn && start >= 0) {
      runs.push({ start, end: hour });
      start = -1;
    }
  }
  return runs;
}

interface WindowPiece {
  /** 0-based day the window belongs to (the day it starts on). */
  dayIndex: number;
  startMinute: number;
  /** 0 means midnight. */
  endMinute: number;
}

/**
 * The windows for an hour grid, as few as possible: each run of hours in a day is a window; a run that
 * reaches midnight and carries on into the early hours of the next day is one overnight window (when
 * that reads as a window: the early hours must stop before the evening ones start); a whole day is two
 * windows, because a window cannot start and end at the same time; and days with the same hours share
 * a window. The result is ordered by start time, then by first day.
 */
export function windowsFromGrid(grid: WeekGrid): TimeWindow[] {
  const runsByDay = grid.map(runsOf);

  // First decide which early-morning runs belong to the night before, for every day, because
  // Sunday night's belongs to Monday, which was already looked at.
  const nightEnds = new Map<string, number>();
  const continuedRuns = new Set<string>();
  runsByDay.forEach((runs, dayIndex) => {
    runs.forEach((run, runIndex) => {
      if (run.end !== 24 || run.start === 0) return;
      const nextDayIndex = (dayIndex + 1) % 7;
      const nextRuns = runsByDay[nextDayIndex] as HourRun[];
      const next = nextRuns[0];
      if (next && next.start === 0 && next.end < run.start) {
        nightEnds.set(`${dayIndex}:${runIndex}`, next.end);
        continuedRuns.add(`${nextDayIndex}:0`);
      }
    });
  });

  const pieces: WindowPiece[] = [];
  runsByDay.forEach((runs, dayIndex) => {
    runs.forEach((run, runIndex) => {
      const key = `${dayIndex}:${runIndex}`;
      if (continuedRuns.has(key)) return;
      const nightEnd = nightEnds.get(key);
      if (nightEnd !== undefined) pieces.push({ dayIndex, startMinute: run.start * 60, endMinute: nightEnd * 60 });
      else if (run.start === 0 && run.end === 24) pieces.push({ dayIndex, startMinute: 0, endMinute: 12 * 60 }, { dayIndex, startMinute: 12 * 60, endMinute: 0 });
      else pieces.push({ dayIndex, startMinute: run.start * 60, endMinute: run.end === 24 ? 0 : run.end * 60 });
    });
  });

  const daysByHours = new Map<string, { startMinute: number; endMinute: number; dayIndexes: number[] }>();
  for (const piece of pieces) {
    const key = `${piece.startMinute}-${piece.endMinute}`;
    const group = daysByHours.get(key) ?? { startMinute: piece.startMinute, endMinute: piece.endMinute, dayIndexes: [] };
    group.dayIndexes.push(piece.dayIndex);
    daysByHours.set(key, group);
  }
  return [...daysByHours.values()]
    .map((group) => ({ ...group, daysOfWeek: group.dayIndexes.map((dayIndex) => dayIndex + 1).sort((first, second) => first - second) }))
    .sort((first, second) => first.startMinute - second.startMinute || (first.daysOfWeek[0] as number) - (second.daysOfWeek[0] as number))
    .map((group) => ({ daysOfWeek: group.daysOfWeek, localStartTime: timeOf(group.startMinute), localEndTime: timeOf(group.endMinute) }));
}
