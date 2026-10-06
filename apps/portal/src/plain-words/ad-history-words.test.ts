import type { AdHistoryEvent } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { describeHistoryActor, describeHistoryEvent } from './ad-history-words';

const base = { id: '1', occurredAt: '2026-10-06T08:00:00Z', actorName: 'Chanda Mwale' };
const event = (rest: object) => ({ ...base, ...rest }) as AdHistoryEvent;

describe('describeHistoryEvent', () => {
  it.each([
    [{ kind: 'ad_created', fileName: 'offer.mp3' }, ['created the ad with offer.mp3']],
    [{ kind: 'ad_created', fileName: null }, ['created the ad']],
    [{ kind: 'ad_renamed', previousTitle: 'Summer', title: 'Summer service offer' }, ['renamed the ad from “Summer” to “Summer service offer”']],
    [{ kind: 'audio_upload_restarted', fileName: 'again.mp3' }, ['started a new upload (again.mp3)']],
    [{ kind: 'audio_upload_checked' }, ['uploaded the audio']],
    [{ kind: 'audio_upload_refused', refusalReason: 'not_the_declared_audio_format' }, ["had the audio refused: This file isn't a valid MP3, WAV or M4A audio file. Choose a different file."]],
    [{ kind: 'audio_upload_refused', refusalReason: 'something_new' }, ["had the audio refused: This file couldn't be used. Choose a different file."]],
    [{ kind: 'ad_published', isRepublish: false }, ['published the ad']],
    [{ kind: 'ad_published', isRepublish: true }, ['updated the published ad']],
    [{ kind: 'schedule_saved', isFirstSave: true, changedParts: [] }, ['set the schedule']],
    [{ kind: 'schedule_saved', isFirstSave: false, changedParts: ['dates'] }, ['changed the dates']],
    [{ kind: 'schedule_saved', isFirstSave: false, changedParts: ['dates', 'hours', 'tap_limit'] }, ['changed the dates, hours on air and tap limit']],
    [{ kind: 'schedule_saved', isFirstSave: false, changedParts: [] }, ['saved the schedule without changing it']],
    [{ kind: 'buttons_saved', isFirstSave: true, buttonChanges: [] }, ['added the buttons']],
    [{ kind: 'buttons_saved', isFirstSave: false, buttonChanges: [] }, ['saved the buttons without changing them']],
  ])('%j reads as %j', (eventDetails, sentences) => {
    expect(describeHistoryEvent(event(eventDetails))).toEqual(sentences);
  });

  it('describes each button change on its own line, naming the part and never a value', () => {
    const sentences = describeHistoryEvent(
      event({
        kind: 'buttons_saved',
        isFirstSave: false,
        buttonChanges: [
          { buttonLabel: 'Chat with us', buttonType: 'WHATSAPP', change: 'changed', changedFields: ['phone_number'] },
          { buttonLabel: 'Call us', buttonType: 'CALL', change: 'changed', changedFields: ['phone_number', 'label'] },
          { buttonLabel: 'Book online', buttonType: 'LINK', change: 'changed', changedFields: ['link'] },
          { buttonLabel: 'Find us', buttonType: 'MAP', change: 'changed', changedFields: ['location', 'place_name'] },
          { buttonLabel: 'Chat with us', buttonType: 'WHATSAPP', change: 'changed', changedFields: ['whatsapp_message'] },
          { buttonLabel: 'Menu', buttonType: 'LINK', change: 'added', changedFields: [] },
          { buttonLabel: 'Old offer', buttonType: 'LINK', change: 'removed', changedFields: [] },
          { buttonLabel: 'Call us', buttonType: 'CALL', change: 'moved', changedFields: [] },
        ],
      }),
    );
    expect(sentences).toEqual([
      'changed the WhatsApp number of “Chat with us”',
      'changed the phone number and label of “Call us”',
      'changed the link of “Book online”',
      'changed the location and place name of “Find us”',
      'changed the first message of “Chat with us”',
      'added the button “Menu”',
      'removed the button “Old offer”',
      'moved the button “Call us”',
    ]);
  });
});

describe('describeHistoryActor', () => {
  it('uses the person\'s name, or says a former team member did it', () => {
    expect(describeHistoryActor(event({ kind: 'audio_upload_checked' }))).toBe('Chanda Mwale');
    expect(describeHistoryActor(event({ kind: 'audio_upload_checked', actorName: null }))).toBe('A former team member');
  });
});
