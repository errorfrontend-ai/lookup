import { MAXIMUM_TIME_WINDOWS_PER_SCHEDULE, TimeWindowInput } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { coverageOf, emptyGrid, gridFromWindows, sameCoverage, type TimeWindow, type WeekGrid, windowsFromGrid } from './schedule-conversion';

/** A grid with the given hours on: `{ 1: [7, 8], 5: [22, 23] }` is Monday 07–09 and Friday 22–24. Days are ISO numbers. */
function gridWith(hoursByDay: Record<number, number[]>): WeekGrid {
  const grid = emptyGrid();
  for (const [day, hours] of Object.entries(hoursByDay)) for (const hour of hours) (grid[Number(day) - 1] as boolean[])[hour] = true;
  return grid;
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_unused, index) => from + index);
const window = (daysOfWeek: number[], localStartTime: string, localEndTime: string): TimeWindow => ({ daysOfWeek, localStartTime, localEndTime });

/** A small seeded random number generator, so a failing pattern can be run again. */
function randomNumbers(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGrid(next: () => number): WeekGrid {
  // A different chance of an hour being on for each grid, so sparse, busy and nearly-full weeks all come up.
  const chance = next();
  const grid = emptyGrid();
  for (const day of grid) for (let hour = 0; hour < 24; hour += 1) day[hour] = next() < chance;
  return grid;
}

describe('turning the hour grid into time windows', () => {
  it('has no windows for an empty week', () => {
    expect(windowsFromGrid(emptyGrid())).toEqual([]);
  });

  it('makes one window for one run of hours', () => {
    expect(windowsFromGrid(gridWith({ 1: [7, 8] }))).toEqual([window([1], '07:00', '09:00')]);
  });

  it('puts days with the same hours in one window, so a schedule stays short', () => {
    const grid = gridWith({ 1: [7, 8], 2: [7, 8], 3: [7, 8], 4: [7, 8], 5: [7, 8] });
    expect(windowsFromGrid(grid)).toEqual([window([1, 2, 3, 4, 5], '07:00', '09:00')]);
  });

  it('makes a separate window for each run of hours in a day, and groups each run across the days that share it', () => {
    const grid = gridWith({ 1: [7, 8, 16, 17], 2: [7, 8, 16, 17], 6: [10] });
    expect(windowsFromGrid(grid)).toEqual([window([1, 2], '07:00', '09:00'), window([6], '10:00', '11:00'), window([1, 2], '16:00', '18:00')]);
  });

  it('writes the end of a run that reaches midnight as 00:00', () => {
    expect(windowsFromGrid(gridWith({ 3: [20, 21, 22, 23] }))).toEqual([window([3], '20:00', '00:00')]);
  });

  it('starts a run at 00:00 when the day starts on air', () => {
    expect(windowsFromGrid(gridWith({ 3: [0, 1, 2] }))).toEqual([window([3], '00:00', '03:00')]);
  });

  it('can have a single hour at either end of the day', () => {
    expect(windowsFromGrid(gridWith({ 2: [0, 23] }))).toEqual([window([2], '00:00', '01:00'), window([2], '23:00', '00:00')]);
  });

  describe('a whole day', () => {
    it('is split in two, because a window cannot start and end at the same time', () => {
      expect(windowsFromGrid(gridWith({ 4: range(0, 24) }))).toEqual([window([4], '00:00', '12:00'), window([4], '12:00', '00:00')]);
    });

    it('keeps every day of a whole week in just those two windows', () => {
      const grid = gridWith(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((day) => [day, range(0, 24)])));
      expect(windowsFromGrid(grid)).toEqual([window([1, 2, 3, 4, 5, 6, 7], '00:00', '12:00'), window([1, 2, 3, 4, 5, 6, 7], '12:00', '00:00')]);
    });

    it('shares a window with a day that only has the afternoon', () => {
      const grid = gridWith({ 1: range(0, 24), 2: range(12, 24) });
      expect(windowsFromGrid(grid)).toEqual([window([1], '00:00', '12:00'), window([1, 2], '12:00', '00:00')]);
    });
  });

  describe('running past midnight', () => {
    it('is one window that belongs to the day it starts: Friday 22:00 to Saturday 02:00', () => {
      const grid = gridWith({ 5: [22, 23], 6: [0, 1] });
      expect(windowsFromGrid(grid)).toEqual([window([5], '22:00', '02:00')]);
    });

    it('works from Sunday into Monday, because the week goes round', () => {
      const grid = gridWith({ 7: [23], 1: [0] });
      expect(windowsFromGrid(grid)).toEqual([window([7], '23:00', '01:00')]);
    });

    it('groups nights that share the same hours', () => {
      const grid = gridWith({ 5: [22, 23], 6: [22, 23, 0, 1], 7: [0, 1] });
      // Friday night runs into Saturday's early hours, and Saturday night into Sunday's: the same hours, so one window.
      expect(windowsFromGrid(grid)).toEqual([window([5, 6], '22:00', '02:00')]);
    });

    it('does not join the hours before midnight and after it when the early hours reach as far as the evening ones start', () => {
      // Friday 10:00 to midnight and Saturday midnight to 12:00 would be 26 hours in one window: that cannot be one window.
      const grid = gridWith({ 5: range(10, 24), 6: range(0, 12) });
      expect(windowsFromGrid(grid)).toEqual([window([6], '00:00', '12:00'), window([5], '10:00', '00:00')]);
    });

    it('joins them when the early hours stop before the evening ones start, even by an hour', () => {
      const grid = gridWith({ 5: range(10, 24), 6: range(0, 9) });
      expect(windowsFromGrid(grid)).toEqual([window([5], '10:00', '09:00')]);
    });

    it('does not join when the early hours would end at the same hour the evening ones start', () => {
      // Friday 10:00→midnight with Saturday 00:00→10:00 would read as Friday 10:00→10:00, which is not a window.
      const grid = gridWith({ 5: range(10, 24), 6: range(0, 10) });
      expect(windowsFromGrid(grid)).toEqual([window([6], '00:00', '10:00'), window([5], '10:00', '00:00')]);
    });

    it('leaves a whole day on its own: it cannot also be the morning of a night', () => {
      const grid = gridWith({ 5: range(20, 24), 6: range(0, 24) });
      expect(windowsFromGrid(grid)).toEqual([window([6], '00:00', '12:00'), window([6], '12:00', '00:00'), window([5], '20:00', '00:00')]);
    });
  });

  describe('every window it makes', () => {
    it('is one the API accepts, in any week at all', () => {
      const next = randomNumbers(20261006);
      for (let attempt = 0; attempt < 400; attempt += 1) {
        for (const timeWindow of windowsFromGrid(randomGrid(next))) {
          expect(TimeWindowInput.safeParse(timeWindow).success, JSON.stringify(timeWindow)).toBe(true);
        }
      }
    });

    it('never repeats the same hours for two windows (days that share hours are always together)', () => {
      const next = randomNumbers(7);
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const windows = windowsFromGrid(randomGrid(next));
        const hours = windows.map((timeWindow) => `${timeWindow.localStartTime}-${timeWindow.localEndTime}`);
        expect(new Set(hours).size).toBe(hours.length);
      }
    });
  });
});

describe('turning time windows into the hour grid', () => {
  it('lights the hours of a window on each of its days', () => {
    const { grid } = gridFromWindows([window([1, 3], '07:00', '09:00')]);
    expect(grid).toEqual(gridWith({ 1: [7, 8], 3: [7, 8] }));
  });

  it('puts the hours after midnight of a night window on the next day', () => {
    const { grid } = gridFromWindows([window([5], '22:00', '02:00')]);
    expect(grid).toEqual(gridWith({ 5: [22, 23], 6: [0, 1] }));
  });

  it('takes 00:00 as the end of the day', () => {
    expect(gridFromWindows([window([2], '20:00', '00:00')]).grid).toEqual(gridWith({ 2: [20, 21, 22, 23] }));
  });

  it('carries a Sunday night into Monday', () => {
    expect(gridFromWindows([window([7], '23:00', '01:00')]).grid).toEqual(gridWith({ 7: [23], 1: [0] }));
  });

  it('joins windows that touch or overlap', () => {
    const { grid } = gridFromWindows([window([1], '07:00', '09:00'), window([1], '08:00', '11:00'), window([1], '11:00', '12:00')]);
    expect(grid).toEqual(gridWith({ 1: range(7, 12) }));
  });

  it('reads the two halves of a split whole day as the whole day', () => {
    const { grid } = gridFromWindows([window([6], '00:00', '12:00'), window([6], '12:00', '00:00')]);
    expect(grid).toEqual(gridWith({ 6: range(0, 24) }));
  });

  it('says when every window is on the hour, so the grid shows it exactly', () => {
    expect(gridFromWindows([window([1], '07:00', '09:00')]).isOnTheHour).toBe(true);
    expect(gridFromWindows([]).isOnTheHour).toBe(true);
  });

  it('says when a window is not on the hour, because the grid could only show it wrongly', () => {
    expect(gridFromWindows([window([1], '07:30', '09:00')]).isOnTheHour).toBe(false);
    expect(gridFromWindows([window([1], '07:00', '09:15')]).isOnTheHour).toBe(false);
    expect(gridFromWindows([window([1], '22:00', '02:30')]).isOnTheHour).toBe(false);
  });

  it('counts a window that starts and ends in the same hour as off the hour', () => {
    expect(gridFromWindows([window([1], '07:10', '07:40')]).isOnTheHour).toBe(false);
  });
});

describe('going round: grid, windows, grid', () => {
  it('gives back the same week for any week at all', () => {
    const next = randomNumbers(42);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const grid = randomGrid(next);
      const back = gridFromWindows(windowsFromGrid(grid));
      expect(back.isOnTheHour).toBe(true);
      expect(back.grid).toEqual(grid);
    }
  });

  it('gives the same windows when done twice', () => {
    const next = randomNumbers(99);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const windows = windowsFromGrid(randomGrid(next));
      expect(windowsFromGrid(gridFromWindows(windows).grid as WeekGrid)).toEqual(windows);
    }
  });

  it('keeps the same minutes on air as the windows it came from', () => {
    const next = randomNumbers(5);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const grid = randomGrid(next);
      const windows = windowsFromGrid(grid);
      // The hours on air, counted straight from the windows, are the hours that were switched on.
      const minutes = coverageOf(windows).filter(Boolean).length;
      expect(minutes).toBe(grid.flat().filter(Boolean).length * 60);
    }
  });

  it('keeps a night window as one window when it is read and written again', () => {
    const windows = [window([5], '22:00', '02:00'), window([1, 2, 3, 4, 5], '07:00', '09:00')];
    expect(windowsFromGrid(gridFromWindows(windows).grid as WeekGrid)).toEqual([window([1, 2, 3, 4, 5], '07:00', '09:00'), window([5], '22:00', '02:00')]);
  });

  it('can need more windows than a schedule may have, which the editor then refuses to save', () => {
    // A different set of hours on every day: no two days share a window.
    const grid = gridWith({ 1: [1, 3, 5, 7], 2: [2, 4, 6, 8], 3: [9, 11, 13, 15], 4: [10, 12, 14, 16], 5: [17, 19, 21, 23], 6: [18, 20, 22, 0], 7: [2, 5, 8, 11] });
    expect(windowsFromGrid(grid).length).toBeGreaterThan(MAXIMUM_TIME_WINDOWS_PER_SCHEDULE);
  });
});

describe('comparing two schedules by the minutes they cover', () => {
  it('says two schedules are the same when they cover the same minutes, however they are written', () => {
    expect(sameCoverage([window([1, 2], '07:00', '09:00')], [window([2], '07:00', '09:00'), window([1], '07:00', '08:00'), window([1], '08:00', '09:00')])).toBe(true);
    expect(sameCoverage([window([5], '22:00', '02:00')], [window([5], '22:00', '00:00'), window([6], '00:00', '02:00')])).toBe(true);
    expect(sameCoverage([window([6], '00:00', '12:00'), window([6], '12:00', '00:00')], [window([6], '00:00', '12:00'), window([6], '12:00', '00:00'), window([6], '06:00', '18:00')])).toBe(true);
  });

  it('says they differ by even one minute, or one day', () => {
    expect(sameCoverage([window([1], '07:00', '09:00')], [window([1], '07:00', '09:01')])).toBe(false);
    expect(sameCoverage([window([1], '07:00', '09:00')], [window([2], '07:00', '09:00')])).toBe(false);
    expect(sameCoverage([window([1], '07:00', '09:00')], [])).toBe(false);
  });

  it('covers nothing for a window with no length', () => {
    expect(coverageOf([window([1, 2], '07:00', '07:00')]).some(Boolean)).toBe(false);
  });

  it('counts a night window on the day it starts, not the day it ends', () => {
    expect(sameCoverage([window([5], '22:00', '02:00')], [window([6], '22:00', '02:00')])).toBe(false);
  });
});
