/** What changed about one button: which one (by its label and type), and how. Never its phone number, link or location. */
export interface ButtonChange {
  buttonLabel: string;
  buttonType: 'LINK' | 'CALL' | 'WHATSAPP' | 'MAP';
  change: 'added' | 'removed' | 'changed' | 'moved';
  /** For "changed": which parts, by name only. */
  changedFields: Array<'type' | 'label' | 'phone_number' | 'whatsapp_message' | 'link' | 'location' | 'place_name'>;
}

export type ScheduleChangedPart = 'dates' | 'hours' | 'grace_period' | 'tap_limit';

/** One thing that happened to an ad, in the kinds the portal knows how to put into words. */
export type AdHistoryEvent = {
  /** The audit row's id, which orders events and pages through them. */
  id: string;
  occurredAt: string;
  /** Who did it, or null for someone who has since left the station's team. */
  actorName: string | null;
} & (
  | { kind: 'ad_created'; fileName: string | null }
  | { kind: 'ad_renamed'; previousTitle: string; title: string }
  | { kind: 'audio_upload_restarted'; fileName: string | null }
  | { kind: 'audio_upload_checked' }
  | { kind: 'audio_upload_refused'; refusalReason: string }
  | { kind: 'buttons_saved'; isFirstSave: boolean; buttonChanges: ButtonChange[] }
  | { kind: 'schedule_saved'; isFirstSave: boolean; changedParts: ScheduleChangedPart[] }
  | { kind: 'ad_published'; isRepublish: boolean }
);

export const AD_HISTORY_EVENTS_PER_PAGE = 20;

/** GET /stations/{stationId}/ads/{adId}/history, newest first. */
export interface AdHistoryPage {
  events: AdHistoryEvent[];
  /** Pass back as ?cursor= for older events; null at the start of the history. */
  nextCursor: string | null;
}
