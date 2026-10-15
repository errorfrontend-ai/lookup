import { z } from 'zod';

/**
 * What listeners did with a station's ads (P5B-OVERVIEW-04 to -16): read from the recognitions and taps themselves
 * until the Phase 7 roll-ups exist (P5B-D2). Days are the station's own, in its time zone, and a recognition counts
 * on the day and hour it was heard, so a clip sent later from a no-signal area lands where it belongs.
 */
export const LISTENER_FIGURES_RANGES = ['today', 'last7Days', 'last30Days'] as const;
export type ListenerFiguresRange = (typeof LISTENER_FIGURES_RANGES)[number];

/** How many of the station's days each range covers: today, and the days before it. */
export const LISTENER_FIGURES_RANGE_DAYS: Record<ListenerFiguresRange, number> = { today: 1, last7Days: 7, last30Days: 30 };

/** GET /stations/{stationId}/listener-figures?range= */
export const ListenerFiguresQuery = z.strictObject({
  range: z.enum(LISTENER_FIGURES_RANGES).default('last7Days'),
});
export type ListenerFiguresQuery = z.infer<typeof ListenerFiguresQuery>;

export interface ListenerFigures {
  range: ListenerFiguresRange;
  /** The first and last of the station's days counted, as YYYY-MM-DD in its time zone (the last is today). */
  firstDay: string;
  lastDay: string;
  /** Recognitions heard today, whatever the range. */
  recognitionsToday: number;
  /**
   * Times listeners identified one of the station's ads and were shown its buttons: a match, the client's usual
   * buttons, or a "Which station?" answered with this station. Never another station's, and never a chooser not
   * yet answered.
   */
  recognitions: number;
  /** Of those, clips kept on the phone with no signal and sent later. */
  recognitionsSentLater: number;
  /** Taps on the buttons of the station's cards (each button counted once per recognition). */
  buttonTaps: number;
  /** Recognitions by the hour they were heard in, station time: 24 numbers, from 00:00 to 23:00. */
  recognitionsByHour: number[];
}

/** What listeners did with one ad over the station's last 7 days (today and the 6 days before). */
export interface AdListenerFigures {
  /** Times listeners identified the ad. */
  heard: number;
  /** Of those, clips sent later from no-signal areas. */
  heardSentLater: number;
  /** Taps on the ad's buttons. */
  buttonTaps: number;
}

/** A share in whole percent, or null when there is nothing to take it of (no recognitions yet). */
export function wholePercentOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}
