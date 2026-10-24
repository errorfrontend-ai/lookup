import { describe, expect, it } from 'vitest';
import { describeCampaignDates, describeHeardLastSevenDays, describeSlot, describeStation, describeStationDay, stationToday } from './client-words';

describe('client words', () => {
  it("knows the station's today in its own time zone, not the browser's", () => {
    // 23:30 UTC on 24 October is already 25 October in Lusaka (UTC+2), still 24 October in London (UTC+1).
    const lateEvening = new Date('2026-10-24T23:30:00Z');
    expect(stationToday('Africa/Lusaka', lateEvening)).toBe('2026-10-25');
    expect(stationToday('Europe/London', lateEvening)).toBe('2026-10-25');
    expect(stationToday('America/New_York', lateEvening)).toBe('2026-10-24');
    expect(stationToday('Not/A_Zone', lateEvening)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each([
    ['2026-10-24', 'Today'],
    ['2026-10-25', 'Tomorrow'],
    ['2026-10-26', 'Mon 26 Oct'],
    ['2026-11-01', 'Sun 1 Nov'],
    ['2027-01-04', 'Mon 4 Jan 2027'],
  ])('P5C-ADVERT-01: %s seen on 24 October 2026 is "%s"', (date, words) => {
    expect(describeStationDay(date, '2026-10-24')).toBe(words);
  });

  it('P5C-ADVERT-01: a slot is its day and its hours, a slot past midnight ending the next morning', () => {
    expect(describeSlot({ localDate: '2026-10-24', localStartTime: '07:00', localEndTime: '09:00' }, '2026-10-24')).toBe('Today 07:00–09:00');
    expect(describeSlot({ localDate: '2026-10-25', localStartTime: '22:00', localEndTime: '01:00' }, '2026-10-24')).toBe('Tomorrow 22:00–01:00');
  });

  it.each([
    ['LIVE_NOW', '2026-10-01', '2026-10-31', 'Until 31 Oct'],
    ['SCHEDULED', '2026-11-01', '2026-11-30', 'From 1 Nov to 30 Nov'],
    ['ENDED', '2026-09-01', '2026-09-30', 'Ended 30 Sep'],
    ['PAUSED', '2026-10-01', '2026-10-31', 'Until 31 Oct'],
  ] as const)('P5C-DASHBOARD-08: a %s campaign from %s to %s reads "%s"', (status, startsOn, endsOn, words) => {
    expect(describeCampaignDates({ status, startsOn, endsOn }, '2026-10-24')).toBe(words);
  });

  it('counts what was heard in words', () => {
    expect([0, 1, 1234].map(describeHeardLastSevenDays)).toEqual(['Not heard in the last 7 days', 'Heard once in the last 7 days', 'Heard 1,234 times in the last 7 days']);
  });

  it('names a station by what it has given', () => {
    expect(describeStation('Station A', '98.1 FM')).toBe('Station A · 98.1 FM');
    expect(describeStation(null, null)).toBe('Your station');
  });
});
