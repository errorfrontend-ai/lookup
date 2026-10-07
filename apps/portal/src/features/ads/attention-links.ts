import type { AdSummary } from '@lookup/contracts';
import { formatStationDate } from '../../formatting/describe-schedule';
import { describeAttentionReason } from '../../plain-words/ad-status-words';

export interface AttentionLink {
  /** What the link says: the first thing to do about the ad's most serious problem. */
  label: string;
  to: string;
  /** Whether it leads into setup (and so is only for people who may change ads). */
  isSetup: boolean;
}

/**
 * The first thing to do about an ad that needs attention, as a link: owners and managers go straight to
 * the step that fixes it (the audio, the review where it is published, or the dates); everyone else,
 * and any problem that is Look Up's to solve, just opens the ad.
 */
export function attentionLink(ad: AdSummary, stationId: string, canChange: boolean): AttentionLink | null {
  const reason = ad.attentionReasons[0];
  if (!reason) return null;
  const adPath = `/stations/${stationId}/ads/${ad.id}`;
  if (!canChange || reason === 'needs_review') return { label: 'View ad', to: adPath, isSetup: false };
  const step = reason === 'ending_soon' ? 'schedule' : reason === 'start_date_passed' ? 'review' : 'audio';
  const { action } = describeAttentionReason(reason, ad.client.name, ad.campaign ? formatStationDate(ad.campaign.endsOn) : null);
  return { label: action, to: `${adPath}/setup?step=${step}`, isSetup: true };
}
