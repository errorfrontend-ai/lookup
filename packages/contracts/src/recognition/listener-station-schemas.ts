import { z } from 'zod';
import { MAXIMUM_CITY_LENGTH } from '../stations/station-schemas.js';
import { PublicImage } from './public-image-schema.js';

/**
 * Rules of the listener's answers that JSON Schema cannot express, checked by zod only. They are rules
 * of what the server sends, never of what a caller sent, so they are not relayed in VALIDATION_FAILED.
 */
export const LISTENER_STATION_LIST_RULE_REASONS = ['station_listed_twice'] as const;
export type ListenerStationListRuleReason = (typeof LISTENER_STATION_LIST_RULE_REASONS)[number];

/**
 * A station as a listener sees it: in a result, in the "Which station?" sheet and in the "My station"
 * list. Only public facts: never its status, whether it is listed in the app, or anything a station
 * keeps to itself. `city` is always sent, as null when the station has not given one.
 */
export const ListenerStation = z
  .strictObject({
    /** The station's id: the one public reference to it, also used as the hint and the listener's choice. */
    id: z.uuid(),
    name: z.string().min(1).max(120),
    frequency_label: z.string().min(1).max(32),
    city: z.string().min(1).max(MAXIMUM_CITY_LENGTH).nullable(),
    logo: PublicImage.nullable(),
  })
  .meta({ id: 'ListenerStation' });
export type ListenerStation = z.infer<typeof ListenerStation>;

/** GET /api/v1/stations sends every listed station in one answer, with no paging, so it is capped. */
export const MAXIMUM_LISTED_STATIONS = 1_000;

/**
 * GET /api/v1/stations: the ACTIVE stations listed in the app, for the "My station" picker, in the
 * server's order (by name, then frequency, then id). An empty list is valid. A station appears once.
 */
export const ListenerStationList = z
  .strictObject({
    stations: z.array(ListenerStation).max(MAXIMUM_LISTED_STATIONS),
  })
  .superRefine((list, context) => {
    const seenStationIds = new Set<string>();
    list.stations.forEach((station, stationIndex) => {
      if (seenStationIds.has(station.id)) {
        const reason: ListenerStationListRuleReason = 'station_listed_twice';
        context.addIssue({ code: 'custom', path: ['stations', stationIndex, 'id'], params: { reason }, message: reason });
      }
      seenStationIds.add(station.id);
    });
  })
  .meta({ id: 'ListenerStationList' });
export type ListenerStationList = z.infer<typeof ListenerStationList>;

/** For the listener app, which shows the list. Refinements (one entry per station) are not included. */
export function emitListenerStationListJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://contracts.lookup.invalid/listener-station-list/1.json',
    ...z.toJSONSchema(ListenerStationList, { target: 'draft-2020-12', io: 'output', unrepresentable: 'throw' }),
  };
}
