import type { AdHistoryEvent, ButtonChange, ScheduleChangedPart } from '@lookup/contracts';
import { describeUploadRefusal } from './upload-words';

const FORMER_MEMBER = 'A former team member';

/** Names a button's part the way a person says it. A phone number is a "WhatsApp number" on a WhatsApp button. */
function describeButtonField(field: ButtonChange['changedFields'][number], buttonType: ButtonChange['buttonType']): string {
  switch (field) {
    case 'phone_number':
      return buttonType === 'WHATSAPP' ? 'WhatsApp number' : 'phone number';
    case 'whatsapp_message':
      return 'first message';
    case 'link':
      return 'link';
    case 'location':
      return 'location';
    case 'place_name':
      return 'place name';
    case 'label':
      return 'label';
    case 'type':
      return 'type';
  }
}

function joinInWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function describeButtonChange(change: ButtonChange): string {
  const name = `“${change.buttonLabel}”`;
  switch (change.change) {
    case 'added':
      return `added the button ${name}`;
    case 'removed':
      return `removed the button ${name}`;
    case 'moved':
      return `moved the button ${name}`;
    case 'changed':
      return `changed the ${joinInWords(change.changedFields.map((field) => describeButtonField(field, change.buttonType)))} of ${name}`;
  }
}

const SCHEDULE_PART_WORDS: Record<ScheduleChangedPart, string> = {
  dates: 'dates',
  hours: 'hours on air',
  grace_period: 'grace period',
  tap_limit: 'tap limit',
};

/**
 * What happened, as sentences that follow the person's name ("Chanda Mwale changed the WhatsApp number
 * of “Chat with us”"). An event can hold several changes, each its own sentence. Never contains a
 * number, link or place: the events themselves carry only labels and the names of parts.
 */
export function describeHistoryEvent(event: AdHistoryEvent): string[] {
  switch (event.kind) {
    case 'ad_created':
      return [event.fileName ? `created the ad with ${event.fileName}` : 'created the ad'];
    case 'ad_renamed':
      return [`renamed the ad from “${event.previousTitle}” to “${event.title}”`];
    case 'audio_upload_restarted':
      return [event.fileName ? `started a new upload (${event.fileName})` : 'started a new upload'];
    case 'audio_upload_checked':
      return ['uploaded the audio'];
    case 'audio_upload_refused':
      return [`had the audio refused: ${describeUploadRefusal(event.refusalReason)}`];
    case 'buttons_saved': {
      if (event.isFirstSave) return ['added the buttons'];
      const sentences = event.buttonChanges.map(describeButtonChange);
      return sentences.length > 0 ? sentences : ['saved the buttons without changing them'];
    }
    case 'schedule_saved': {
      if (event.isFirstSave) return ['set the schedule'];
      return [event.changedParts.length > 0 ? `changed the ${joinInWords(event.changedParts.map((part) => SCHEDULE_PART_WORDS[part]))}` : 'saved the schedule without changing it'];
    }
    case 'ad_published':
      return [event.isRepublish ? 'updated the published ad' : 'published the ad'];
  }
}

/** Who did it, in words. */
export function describeHistoryActor(event: AdHistoryEvent): string {
  return event.actorName ?? FORMER_MEMBER;
}
