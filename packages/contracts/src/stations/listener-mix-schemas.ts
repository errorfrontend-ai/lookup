import { z } from 'zod';
import { LISTENER_AGE_BANDS, LISTENER_GENDERS } from '../listener-accounts/listener-account-schemas.js';
import { LISTENER_FIGURES_RANGES } from './listener-figures-schemas.js';

/**
 * Who is listening (ADR-005, docs/design/listener-accounts.md §7; LA-STATS-01 to -07): how many different listeners
 * identified a station's ads, by gender and by age band, for the people who gave them when they made an account.
 *
 * A station, an advertiser or an admin sees groups and never a person: there is no email, no listener id and no row per
 * listener anywhere in this answer. There are two separate breakdowns and never a gender × age grid, so a small group
 * cannot be found by crossing them. Below 10 known listeners there is no breakdown at all, and a group of 1 to 9 is
 * folded into "other groups" (LA-D10). The rule is the pure function that builds this answer, not the database.
 */

/** A group with fewer listeners than this is never shown by itself (LA-D10). */
export const LISTENER_MIX_MINIMUM_GROUP_SIZE = 10;

/** What small groups are folded into. */
export const OTHER_LISTENER_GROUPS = 'OTHER_GROUPS' as const;

/** GET /stations/{stationId}/listener-mix?range= and /stations/{stationId}/ads/{adId}/listener-mix?range= */
export const ListenerMixQuery = z.strictObject({
  range: z.enum(LISTENER_FIGURES_RANGES).default('last7Days'),
});
export type ListenerMixQuery = z.infer<typeof ListenerMixQuery>;

const ListenerCount = z.number().int().nonnegative();
const StationDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const GenderGroup = z.strictObject({ group: z.enum([...LISTENER_GENDERS, OTHER_LISTENER_GROUPS]), listeners: ListenerCount });
const AgeBandGroup = z.strictObject({ group: z.enum([...LISTENER_AGE_BANDS, OTHER_LISTENER_GROUPS]), listeners: ListenerCount });

export const ListenerMix = z.strictObject({
  range: z.enum(LISTENER_FIGURES_RANGES),
  /** The first and last of the station's days counted, as YYYY-MM-DD in its time zone (the last is today). */
  firstDay: StationDay,
  lastDay: StationDay,
  /** Different people who identified the station's ads: one per account, and one per phone not yet linked to an account. */
  listeners: ListenerCount,
  /** Of those, the people who gave their gender and age (one count per account, however many phones it has). */
  knownListeners: ListenerCount,
  /** Of those, the phones whose listener has no account (or has signed out), so nothing is known about them yet. */
  notKnownYetListeners: ListenerCount,
  /** Known listeners by gender, or null while there are fewer than 10 known listeners. */
  genders: z.array(GenderGroup).nullable(),
  /** Known listeners by age band, or null while there are fewer than 10 known listeners. */
  ageBands: z.array(AgeBandGroup).nullable(),
});
export type ListenerMix = z.infer<typeof ListenerMix>;
export type ListenerMixGenderGroup = z.infer<typeof GenderGroup>;
export type ListenerMixAgeBandGroup = z.infer<typeof AgeBandGroup>;
