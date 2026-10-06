import type { AdStatus, CampaignDisplayStatus } from '@lookup/contracts';
import { describeCampaignStatus, describeFileStatus } from '../plain-words/ad-status-words';
import { Badge } from './badge';

/** The ON AIR badge: for an ad that is live this minute. The dot pulses slowly, and stops under reduced motion. */
export function OnAirBadge() {
  return (
    <Badge tone="accent" className="uppercase tracking-wide">
      <span aria-hidden="true" className="size-2 animate-on-air rounded-full bg-on-accent motion-reduce:animate-none" />
      <span className="sr-only">On air now</span>
      <span aria-hidden="true">On air</span>
    </Badge>
  );
}

/** Where a campaign stands. `null` means the ad has no schedule yet. */
export function CampaignStatusBadge({ status }: { status: CampaignDisplayStatus | null }) {
  if (status === 'LIVE_NOW') return <OnAirBadge />;
  const words = describeCampaignStatus(status);
  return (
    <Badge tone={words.tone}>
      <span title={words.hint}>{words.label}</span>
    </Badge>
  );
}

/** Where the audio file stands. While an upload is running, pass its percentage. */
export function FileStatusBadge({ status, uploadPercent = null }: { status: AdStatus; uploadPercent?: number | null }) {
  const words = describeFileStatus(status, uploadPercent);
  return (
    <Badge tone={words.tone}>
      <span title={words.hint}>{words.label}</span>
    </Badge>
  );
}
