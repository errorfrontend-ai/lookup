import type { AdDetail, PublishBlocker } from '@lookup/contracts';
import { formatStationDate } from '../formatting/describe-schedule';

/** The part of setup that fixes a blocker. */
export type PublishFixStep = 'audio' | 'buttons' | 'schedule';

export const PUBLISH_BLOCKER_WORDS: Record<PublishBlocker, { problem: string; fixLabel: string; step: PublishFixStep }> = {
  upload_not_verified: { problem: "The audio hasn't arrived and been checked yet.", fixLabel: 'Go to the audio', step: 'audio' },
  action_card_missing: { problem: 'There are no buttons yet.', fixLabel: 'Add buttons', step: 'buttons' },
  schedule_missing: { problem: "It isn't scheduled yet.", fixLabel: 'Set the schedule', step: 'schedule' },
  schedule_already_ended: { problem: 'Its last day has already passed.', fixLabel: 'Change the dates', step: 'schedule' },
};

/** What to tell the station once the ad is published: on air now, from a day, or at its next time. `today` is the station's date. */
export function describePublished(ad: Pick<AdDetail, 'campaign'>, today: string): string {
  const campaign = ad.campaign;
  if (campaign?.displayStatus === 'LIVE_NOW') return 'Published. It is on air now.';
  if (campaign && campaign.startsOn > today) return `Published. It goes on air from ${formatStationDate(campaign.startsOn)}.`;
  return 'Published. It goes on air at its next time.';
}
