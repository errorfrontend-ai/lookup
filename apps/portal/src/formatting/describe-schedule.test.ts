import { describe, expect, it } from 'vitest';
import {
  describeDays,
  describeScheduleSummary,
  describeTimeWindow,
  formatDateRange,
  formatStationDate,
  hoursOnAirPerWeek,
} from './describe-schedule';

describe('describeDays', () => {
  it.each([
    [[1, 2, 3, 4, 5], 'Mon–Fri'],
    [[6, 7], 'Sat, Sun'],
    [[1, 3, 5], 'Mon, Wed, Fri'],
    [[1, 2, 3, 4, 5, 6, 7], 'Every day'],
    [[7], 'Sun'],
    [[5, 1, 3, 2, 4, 3], 'Mon–Fri'],
    [[1, 2, 3, 6, 7], 'Mon–Wed, Sat, Sun'],
    [[1, 2], 'Mon, Tue'],
    [[], 'No days'],
  ])('%j is %s', (days, expected) => {
    expect(describeDays(days)).toBe(expected);
  });
});

describe('describing times', () => {
  it('writes a window as days and hours, and a longer schedule as its first window plus the rest', () => {
    const morning = { daysOfWeek: [1, 2, 3, 4, 5], localStartTime: '07:00', localEndTime: '09:00' };
    const evening = { daysOfWeek: [1, 2, 3, 4, 5], localStartTime: '17:00', localEndTime: '19:00' };
    expect(describeTimeWindow(morning)).toBe('Mon–Fri · 07:00–09:00');
    expect(describeScheduleSummary([morning])).toBe('Mon–Fri · 07:00–09:00');
    expect(describeScheduleSummary([morning, evening])).toBe('Mon–Fri · 07:00–09:00 +1 more');
    expect(describeScheduleSummary([])).toBe('No times set');
  });

  it('counts hours on air per week, once each, including windows that run past midnight', () => {
    expect(hoursOnAirPerWeek([{ daysOfWeek: [1, 2, 3, 4, 5], localStartTime: '07:00', localEndTime: '09:00' }])).toBe(10);
    expect(hoursOnAirPerWeek([{ daysOfWeek: [5], localStartTime: '22:00', localEndTime: '02:00' }])).toBe(4);
    // Overlapping windows are not counted twice.
    expect(
      hoursOnAirPerWeek([
        { daysOfWeek: [1], localStartTime: '07:00', localEndTime: '10:00' },
        { daysOfWeek: [1], localStartTime: '09:00', localEndTime: '11:00' },
      ]),
    ).toBe(4);
    expect(hoursOnAirPerWeek([{ daysOfWeek: [1], localStartTime: '07:30', localEndTime: '08:00' }])).toBe(0.5);
    expect(hoursOnAirPerWeek([])).toBe(0);
  });
});

describe('dates', () => {
  it('writes a station date without shifting it by the viewer\'s time zone', () => {
    expect(formatStationDate('2026-10-01')).toBe('1 Oct');
    expect(formatStationDate('2026-12-31', true)).toBe('31 Dec 2026');
  });

  it.each([
    ['2026-10-01', '2026-10-31', '1 – 31 Oct'],
    ['2026-09-28', '2026-10-03', '28 Sep – 3 Oct'],
    ['2026-12-20', '2027-01-10', '20 Dec 2026 – 10 Jan 2027'],
    ['2026-10-05', '2026-10-05', '5 Oct'],
  ])('%s to %s reads %s', (from, to, expected) => {
    expect(formatDateRange(from, to)).toBe(expected);
  });
});
