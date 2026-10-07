import { type AdDetail, PUBLISH_BLOCKERS, type PublishBlocker } from '@lookup/contracts';

const VERIFIED_UPLOAD_STATUSES: readonly AdDetail['status'][] = ['PROCESSING', 'READY', 'NEEDS_REVIEW'];

/**
 * What stops an ad being published, in the order the API checks it: the audio has arrived and been
 * checked, there are buttons, and there are times that have not already ended. `today` is the date in
 * the station's time zone; the last day counts until it is over. The API checks again when Publish is
 * pressed, so this is only for showing the reasons early.
 */
export function findPublishBlockers(ad: Pick<AdDetail, 'status' | 'actionCard' | 'schedule'>, today: string): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];
  if (!VERIFIED_UPLOAD_STATUSES.includes(ad.status)) blockers.push('upload_not_verified');
  if (!ad.actionCard) blockers.push('action_card_missing');
  if (!ad.schedule || ad.schedule.timeWindows.length === 0) blockers.push('schedule_missing');
  else if (ad.schedule.endsOn < today) blockers.push('schedule_already_ended');
  return blockers;
}

/** The blockers named in an API refusal, in a fixed order, ignoring anything this page does not know. */
export function blockersFromApiFields(fields: ReadonlyArray<{ code: string }>): PublishBlocker[] {
  return PUBLISH_BLOCKERS.filter((blocker) => fields.some((field) => field.code === blocker));
}
