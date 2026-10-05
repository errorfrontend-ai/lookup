import { z } from 'zod';
import type { ActionCard } from '../action-card/action-card-schema.js';
import type { AdCampaignSummary, AdSummary } from './ad-schemas.js';

/** Minutes after a time window closes during which a listener who identifies the ad still counts. */
export const GRACE_PERIOD_MINUTES_OPTIONS = [0, 5, 10, 20] as const;
export const DEFAULT_GRACE_PERIOD_MINUTES = 10;
export const MAXIMUM_TIME_WINDOWS_PER_SCHEDULE = 21;
export const MAXIMUM_ENGAGEMENT_LIMIT = 1_000_000;

/** Rules a schedule must follow that a JSON shape can't express; relayed as field reason codes. */
export const SCHEDULE_RULE_REASONS = ['end_before_start', 'window_start_equals_end', 'days_must_be_unique', 'date_does_not_exist'] as const;
export type ScheduleRuleReason = (typeof SCHEDULE_RULE_REASONS)[number];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date in the station's time zone, "YYYY-MM-DD". */
const StationLocalDate = z
  .string()
  .regex(DATE_PATTERN)
  .superRefine((value, context) => {
    if (!DATE_PATTERN.test(value)) return; // already reported as invalid_format; one problem per field
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const asDate = new Date(Date.UTC(year, month - 1, day));
    if (asDate.getUTCFullYear() !== year || asDate.getUTCMonth() !== month - 1 || asDate.getUTCDate() !== day) {
      context.addIssue({ code: 'custom', params: { reason: 'date_does_not_exist' }, message: 'date_does_not_exist' });
    }
  });

/** A time of day in the station's time zone, "HH:MM" (24-hour). */
const StationLocalTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

/**
 * A weekly window when the ad airs. Days are ISO numbers (1 = Monday … 7 = Sunday). An end before the
 * start runs past midnight and belongs to the day it starts: Friday 22:00–02:00 covers Saturday 01:00.
 */
export const TimeWindowInput = z
  .strictObject({
    daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    localStartTime: StationLocalTime,
    localEndTime: StationLocalTime,
  })
  .superRefine((window, context) => {
    if (new Set(window.daysOfWeek).size !== window.daysOfWeek.length) {
      context.addIssue({ code: 'custom', path: ['daysOfWeek'], params: { reason: 'days_must_be_unique' }, message: 'days_must_be_unique' });
    }
    if (window.localStartTime === window.localEndTime) {
      context.addIssue({ code: 'custom', path: ['localEndTime'], params: { reason: 'window_start_equals_end' }, message: 'window_start_equals_end' });
    }
  });
export type TimeWindowInput = z.infer<typeof TimeWindowInput>;

export const ScheduleInput = z
  .strictObject({
    startsOn: StationLocalDate,
    endsOn: StationLocalDate,
    timeWindows: z.array(TimeWindowInput).min(1).max(MAXIMUM_TIME_WINDOWS_PER_SCHEDULE),
    gracePeriodMinutes: z.union(GRACE_PERIOD_MINUTES_OPTIONS.map((minutes) => z.literal(minutes))),
    /** After this many button taps, listeners see the client's default card instead. Null for no limit. */
    engagementLimit: z.number().int().min(1).max(MAXIMUM_ENGAGEMENT_LIMIT).nullable().default(null),
  })
  .superRefine((schedule, context) => {
    const bothDatesWellFormed = DATE_PATTERN.test(schedule.startsOn) && DATE_PATTERN.test(schedule.endsOn);
    if (bothDatesWellFormed && schedule.endsOn < schedule.startsOn) {
      context.addIssue({ code: 'custom', path: ['endsOn'], params: { reason: 'end_before_start' }, message: 'end_before_start' });
    }
  });
export type ScheduleInput = z.infer<typeof ScheduleInput>;

/** Why an ad can't be published yet; each names the step still to do. */
export const PUBLISH_BLOCKERS = ['upload_not_verified', 'action_card_missing', 'schedule_missing', 'schedule_already_ended'] as const;
export type PublishBlocker = (typeof PUBLISH_BLOCKERS)[number];

export interface AdSchedule extends AdCampaignSummary {
  timeWindows: TimeWindowInput[];
  gracePeriodMinutes: number;
  engagementLimit: number | null;
  stationTimeZone: string;
}

export interface AdDetail extends AdSummary {
  uploadSizeBytes: number | null;
  /** Why the upload was refused (an UploadRefusalReason), or null. */
  processingErrorCode: string | null;
  actionCard: ActionCard | null;
  schedule: AdSchedule | null;
  createdAt: string;
}
