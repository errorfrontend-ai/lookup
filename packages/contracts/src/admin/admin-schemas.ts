import { z } from 'zod';
import type { StationStatus } from '../authentication/authentication-schemas.js';
import type { LicenceDocumentSummary } from '../registration/station-upload-schemas.js';

/**
 * The super-admin console (design §3.3, §4.4, §4.6). Every route needs a super admin whose session
 * has passed the two-factor code.
 */

/** GET /admin/summary — the navigation's badges. */
export interface AdminSummary {
  waitingApplicationCount: number;
  audioToCheckCount: number;
}

/** A new station, or a change an approved station asked for (O2, decided 10 October 2026). */
export const APPLICATION_KINDS = ['NEW_STATION', 'DETAIL_CHANGE'] as const;
export type ApplicationKind = (typeof APPLICATION_KINDS)[number];

/** Another station already uses this frequency in this town (plan §A Duplicate guard). */
export interface DuplicateStationFlag {
  matchedStationStatus: StationStatus;
}

/** GET /admin/applications — one waiting application, oldest first. */
export interface ApplicationQueueEntry {
  stationId: string;
  kind: ApplicationKind;
  changeRequestId: string | null;
  name: string;
  frequencyLabel: string;
  city: string | null;
  province: string | null;
  submittedAt: string;
  duplicate: DuplicateStationFlag | null;
}

export interface ApplicationQueue {
  entries: ApplicationQueueEntry[];
}

/** GET /admin/applications/{stationId} */
export interface ApplicationDetail extends ApplicationQueueEntry {
  checks: { isPhoneVerified: boolean; isEmailVerified: boolean; hasLicenceDocument: boolean };
  /** The contact's phone is masked; the full number is never sent to the console. */
  contact: { name: string | null; phoneNumberMasked: string | null };
  licenceNumber: string | null;
  timeZone: string;
  coverageNote: string | null;
  streamAddress: string | null;
  licenceDocument: LicenceDocumentSummary | null;
  /** For a change request: what the station asks for (the fields above are its approved values). */
  proposedChange: {
    name: string;
    frequencyLabel: string;
    licenceNumber: string;
    licenceDocument: LicenceDocumentSummary | null;
  } | null;
}

export const MINIMUM_DECISION_REASON_LENGTH = 10;
export const MAXIMUM_DECISION_REASON_LENGTH = 1000;
const DecisionReason = z.string().trim().min(MINIMUM_DECISION_REASON_LENGTH).max(MAXIMUM_DECISION_REASON_LENGTH);

/** POST /admin/applications/{stationId}/rejection and /admin/change-requests/{id}/rejection — the station sees this. */
export const RejectApplicationInput = z.strictObject({ reason: DecisionReason });
export type RejectApplicationInput = z.infer<typeof RejectApplicationInput>;

/** POST /admin/stations/{stationId}/suspension */
export const SuspendStationInput = z.strictObject({ reason: DecisionReason });
export type SuspendStationInput = z.infer<typeof SuspendStationInput>;

/** A short-lived private address for a stored file (the licence document: 5 minutes). */
export interface PrivateFileLink {
  address: string;
  contentType: string;
  expiresAt: string;
}

/** GET /admin/stations?search=&cursor= */
export const AdminStationSearchInput = z.strictObject({
  search: z.string().trim().max(80).optional(),
  cursor: z.string().max(200).optional(),
});
export type AdminStationSearchInput = z.infer<typeof AdminStationSearchInput>;

export interface AdminStationListItem {
  id: string;
  name: string | null;
  frequencyLabel: string | null;
  city: string | null;
  province: string | null;
  status: StationStatus;
  memberCount: number;
  lastDecisionAt: string | null;
}

export interface AdminStationList {
  stations: AdminStationListItem[];
  nextCursor: string | null;
}

/** One side of an overlap: the audio asset and the ads (at any station) that use it. Only super admins see this (O6). */
export interface AudioOverlapSide {
  audioAssetNumber: number;
  ads: Array<{ adId: string; adTitle: string; stationId: string; stationName: string | null }>;
}

/** GET /admin/audio-overlaps */
export interface AudioOverlapFinding {
  id: string;
  overlapMilliseconds: number;
  foundAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  first: AudioOverlapSide;
  second: AudioOverlapSide;
}

export interface AudioOverlapList {
  findings: AudioOverlapFinding[];
}

/** POST /admin/audio-overlaps/{findingId}/review */
export const ReviewAudioOverlapInput = z.strictObject({ note: z.string().trim().min(1).max(500).nullable() });
export type ReviewAudioOverlapInput = z.infer<typeof ReviewAudioOverlapInput>;

/** POST /admin/audio-overlaps/{findingId}/preview-links */
export interface AudioOverlapPreviewLinks {
  first: PrivateFileLink | null;
  second: PrivateFileLink | null;
}

export const HEALTH_QUEUE_NAMES = ['recognize', 'ingest', 'notify'] as const;
export type HealthQueueName = (typeof HEALTH_QUEUE_NAMES)[number];

/** GET /admin/system-health (design §4.6: the last 24 hours). */
export interface SystemHealth {
  measuredAt: string;
  periodHours: number;
  queues: Array<{ name: HealthQueueName; depth: number }>;
  workers: Array<{ name: HealthQueueName; isRunning: boolean }>;
  recognitionCount: number;
  matchMillisecondsAt95thPercentile: number | null;
  /** Failed recognitions (timeout, busy, error) over all finished recognitions; null when there were none. */
  errorRate: number | null;
}

/** GET /admin/reference-codes/{code} */
export interface ReferenceCodeSearchResult {
  searchedFor: string;
  recognitions: Array<{ requestId: string; receivedAt: string; outcome: string; stationName: string | null }>;
  auditEvents: Array<{
    requestId: string;
    occurredAt: string;
    action: string;
    entityType: string;
    actorName: string | null;
    stationName: string | null;
  }>;
}

/**
 * What the super admin typed into "Find by reference code": the code the app shows ("E0AE-F485"),
 * the same 8 hex digits without the dash, or a full request id as the portal shows it. Null for
 * anything else.
 */
export function readReferenceCodeQuery(typed: string): { kind: 'prefix'; prefix: string } | { kind: 'request-id'; requestId: string } | null {
  const compact = typed.trim().toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(compact)) return { kind: 'request-id', requestId: compact };
  const withoutDash = compact.replace(/^([0-9a-f]{4})-([0-9a-f]{4})$/, '$1$2');
  if (/^[0-9a-f]{8}$/.test(withoutDash)) return { kind: 'prefix', prefix: withoutDash };
  return null;
}
