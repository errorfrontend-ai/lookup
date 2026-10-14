import type { StationStatus } from '@lookup/contracts';

const RELATIVE = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

/** "3 hours ago", "2 days ago": how long an application has waited. */
export function ageWords(isoTime: string, now = Date.now()): string {
  const minutes = Math.round((Date.parse(isoTime) - now) / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return RELATIVE.format(hours, 'hour');
  return RELATIVE.format(Math.round(hours / 24), 'day');
}

/** The duplicate flag's pill (P5A-D17), naming the other station's status. */
export function duplicateWords(status: StationStatus): string {
  const other =
    status === 'ACTIVE' ? 'an approved station' : status === 'PENDING_REVIEW' ? 'a station waiting for review' : status === 'SUSPENDED' ? 'a suspended station' : 'another station';
  return `Check: Same frequency and town as ${other}`;
}

/** A station's status as the console lists it. */
export const STATION_STATUS_WORDS: Record<StationStatus, string> = {
  PENDING_VERIFICATION: 'Signing up',
  PENDING_REVIEW: 'Waiting for review',
  ACTIVE: 'Approved',
  REJECTED: 'Rejected',
  SUSPENDED: 'Suspended',
};

/** A recognition's outcome in plain words, for "Find by reference code". */
export const OUTCOME_WORDS: Record<string, string> = {
  PENDING: 'Still being identified',
  MATCH: 'Found an ad',
  MATCH_DEFAULT: "Found an ad (the client's usual card)",
  CHOOSE_STATION: 'Asked which station',
  NO_MATCH: 'No match',
  AMBIGUOUS: 'Unsure (shown as no match)',
  INVALID_AUDIO: 'Recording unusable',
  TIMEOUT: 'Took too long',
  BUSY: 'Busy',
  ERROR: 'Failed on our side',
};

/** An audit action in plain words ("station_application_approved" → "Station application approved"). */
export function actionWords(action: string): string {
  const words = action.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
