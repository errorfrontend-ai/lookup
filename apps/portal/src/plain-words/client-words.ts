import type { ClientAdSummary, ClientSlot } from '@lookup/contracts';
import { formatStationDate } from '../formatting/describe-schedule';

const SHORT_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** The station's own date now, "YYYY-MM-DD", in its time zone (a client may be in another). */
export function stationToday(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    // A time zone this browser doesn't know: the browser's own date is the nearest guess.
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
}

/** The date after a station date. */
function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** "Today", "Tomorrow", or "Mon 26 Oct", for a station date seen from the station's today. */
export function describeStationDay(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === nextDate(today)) return 'Tomorrow';
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return `${SHORT_DAY_NAMES[weekday]} ${formatStationDate(date, date.slice(0, 4) !== today.slice(0, 4))}`;
}

/** A slot as people say it: "Today 07:00–09:00", "Tomorrow 22:00–01:00", "Mon 26 Oct 06:00–09:00". */
export function describeSlot(slot: Pick<ClientSlot, 'localDate' | 'localStartTime' | 'localEndTime'>, today: string): string {
  return `${describeStationDay(slot.localDate, today)} ${slot.localStartTime}–${slot.localEndTime}`;
}

/** The campaign's dates in a few words: "Until 31 Oct", "From 1 Nov to 30 Nov", "Ended 30 Sep". */
export function describeCampaignDates(ad: Pick<ClientAdSummary, 'status' | 'startsOn' | 'endsOn'>, today: string): string {
  if (ad.status === 'ENDED' || ad.endsOn < today) return `Ended ${formatStationDate(ad.endsOn)}`;
  if (ad.startsOn > today) return `From ${formatStationDate(ad.startsOn)} to ${formatStationDate(ad.endsOn)}`;
  return `Until ${formatStationDate(ad.endsOn)}`;
}

/** An advert's identifications over the last 7 days, in the words the client sees: "Heard 8 times in the last 7 days". */
export function describeHeardLastSevenDays(heard: number): string {
  if (heard === 0) return 'Not heard in the last 7 days';
  return heard === 1 ? 'Heard once in the last 7 days' : `Heard ${heard.toLocaleString('en-US')} times in the last 7 days`;
}

/** "Station A · 98.1 FM", leaving out what the station has not given yet. */
export function describeStation(stationName: string | null, frequencyLabel: string | null): string {
  return [stationName ?? 'Your station', frequencyLabel].filter(Boolean).join(' · ');
}
