import type { AdAttentionReason, AdStatus, CampaignDisplayStatus } from '@lookup/contracts';
import type { BadgeTone } from '../components/badge';

export interface StatusWords {
  label: string;
  tone: BadgeTone;
  /** One sentence for a tooltip or the line under a status, when the label alone isn't enough. */
  hint: string;
}

/** What a campaign's status is called. "Live now" has its own badge (OnAirBadge), so its words are for plain text. */
export function describeCampaignStatus(status: CampaignDisplayStatus | null): StatusWords {
  switch (status) {
    case 'LIVE_NOW':
      return { label: 'On air now', tone: 'accent', hint: 'Listeners who identify this ad get its buttons right now.' };
    case 'SCHEDULED':
      return { label: 'Scheduled', tone: 'neutral', hint: 'Published. It goes on air during its hours.' };
    case 'PAUSED':
      return { label: 'Paused', tone: 'warning', hint: 'Published, but switched off for now.' };
    case 'ENDED':
      return { label: 'Ended', tone: 'outline', hint: 'Its last day has passed.' };
    case 'DRAFT':
      return { label: 'Draft', tone: 'outline', hint: 'Not published yet.' };
    default:
      return { label: 'Not scheduled yet', tone: 'outline', hint: 'Set when this ad airs, then publish it.' };
  }
}

/**
 * What the audio file's state is called. In this version a checked upload stays "Audio checked":
 * Look Up prepares it for recognition once the recognition service is switched on.
 */
export function describeFileStatus(status: AdStatus, uploadPercent: number | null = null): StatusWords {
  switch (status) {
    case 'AWAITING_UPLOAD':
      return uploadPercent === null
        ? { label: 'Waiting for the audio', tone: 'warning', hint: 'The audio file has not arrived yet.' }
        : { label: `Uploading ${uploadPercent}%`, tone: 'warning', hint: 'Keep this page open until the upload finishes.' };
    case 'PROCESSING':
      return {
        label: 'Audio checked',
        tone: 'neutral',
        hint: 'Your audio arrived safely. Look Up prepares it for recognition once recognition is switched on.',
      };
    case 'READY':
      return { label: 'Ready for listeners', tone: 'success', hint: 'Listeners can identify this ad.' };
    case 'NEEDS_REVIEW':
      return { label: 'Being checked', tone: 'warning', hint: "Look Up is checking this audio by hand. This page updates when it's done." };
    case 'FAILED':
      return { label: 'Upload refused', tone: 'danger', hint: "The audio couldn't be used. Upload it again or choose a different file." };
  }
}

export interface AttentionWords {
  title: string;
  detail: string;
  /** What to do about it, as the text of the link. */
  action: string;
}

/** What each "needs attention" reason says, and the first thing to do about it. */
export function describeAttentionReason(reason: AdAttentionReason, clientName: string, endsOn: string | null): AttentionWords {
  switch (reason) {
    case 'upload_refused':
      return { title: `${clientName} · upload refused`, detail: "The audio couldn't be used.", action: 'Upload again' };
    case 'needs_review':
      return { title: `${clientName} · being checked`, detail: "Look Up is checking this audio by hand.", action: 'View' };
    case 'upload_not_finished':
      return { title: `${clientName} · upload didn't finish`, detail: 'The audio never finished uploading.', action: 'Upload again' };
    case 'start_date_passed':
      return { title: `${clientName} · not published`, detail: 'It was meant to start already, but it is still a draft.', action: 'Review and publish' };
    case 'ending_soon':
      return { title: `${clientName} · ends soon`, detail: endsOn ? `Its last day is ${endsOn}.` : 'It ends in the next few days.', action: 'Extend the dates' };
  }
}
