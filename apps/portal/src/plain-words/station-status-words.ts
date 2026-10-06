import type { StationRole, StationStatus } from '@lookup/contracts';
import type { BadgeTone } from '../components/badge';

export interface StationStatusWords {
  label: string;
  tone: BadgeTone;
  /** Shown as a banner on every page while the station can't add ads yet; null when nothing needs saying. */
  banner: string | null;
}

export function describeStationStatus(status: StationStatus): StationStatusWords {
  switch (status) {
    case 'ACTIVE':
      return { label: 'Approved', tone: 'success', banner: null };
    case 'PENDING_VERIFICATION':
      return { label: 'Finishing sign-up', tone: 'warning', banner: "This station hasn't finished signing up yet, so ads can't be added." };
    case 'PENDING_REVIEW':
      return {
        label: 'Under review',
        tone: 'warning',
        banner: "Look Up is checking this station's licence. You'll be able to add ads once it's approved.",
      };
    case 'REJECTED':
      return { label: 'Not approved', tone: 'danger', banner: "This station's application wasn't approved, so ads can't be added." };
    case 'SUSPENDED':
      return {
        label: 'Suspended',
        tone: 'danger',
        banner: "This station is suspended. Listeners can't see its ads. Contact Look Up support for help.",
      };
  }
}

const ROLE_WORDS: Record<StationRole, string> = { OWNER: 'Owner', MANAGER: 'Manager', ANALYST: 'Analyst' };

export function describeStationRole(role: StationRole): string {
  return ROLE_WORDS[role];
}
