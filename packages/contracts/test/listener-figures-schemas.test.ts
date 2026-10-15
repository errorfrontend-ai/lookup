import { describe, expect, it } from 'vitest';
import { LISTENER_FIGURES_RANGE_DAYS, LISTENER_FIGURES_RANGES, ListenerFiguresQuery, wholePercentOf } from '../src/stations/listener-figures-schemas.js';

describe('listener figures', () => {
  it('P5B-OVERVIEW-06: the tap rate is taps over recognitions in whole percent: 30 taps over 120 recognitions is 25 %', () => {
    expect(wholePercentOf(30, 120)).toBe(25);
    expect(wholePercentOf(1, 3)).toBe(33);
    expect(wholePercentOf(2, 3)).toBe(67);
    // More taps than recognitions (several buttons on one card) goes above 100.
    expect(wholePercentOf(150, 120)).toBe(125);
  });

  it('gives no percentage when there is nothing to take it of', () => {
    expect(wholePercentOf(0, 0)).toBeNull();
    expect(wholePercentOf(5, 0)).toBeNull();
    expect(wholePercentOf(0, 10)).toBe(0);
  });

  it('P5B-OVERVIEW-02: the ranges are today, the last 7 days (the default) and the last 30 days, and nothing else', () => {
    expect(LISTENER_FIGURES_RANGES).toEqual(['today', 'last7Days', 'last30Days']);
    expect(LISTENER_FIGURES_RANGE_DAYS).toEqual({ today: 1, last7Days: 7, last30Days: 30 });
    expect(ListenerFiguresQuery.parse({})).toEqual({ range: 'last7Days' });
    expect(ListenerFiguresQuery.safeParse({ range: 'yesterday' }).success).toBe(false);
    expect(ListenerFiguresQuery.safeParse({ range: 'today', extra: '1' }).success).toBe(false);
  });
});
