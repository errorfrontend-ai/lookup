import type { ActionCard } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { type AdHistoryAuditRow, describeAdHistoryEvent } from '../src/features/ad-history/describe-ad-history-event.js';

const CALL_ID = '0190f1a2-0000-7000-8000-0000000000c1';
const WHATSAPP_ID = '0190f1a2-0000-7000-8000-0000000000c2';
const LINK_ID = '0190f1a2-0000-7000-8000-0000000000c3';
const MAP_ID = '0190f1a2-0000-7000-8000-0000000000c4';

const callButton = { type: 'CALL', id: CALL_ID, label: 'Call us', style: 'PRIMARY', phone_number_e164: '+260977123456' } as const;
const whatsAppButton = { type: 'WHATSAPP', id: WHATSAPP_ID, label: 'Chat with us', style: 'SECONDARY', phone_number_e164: '+260966000111', prefilled_text: 'Hello there' } as const;
const linkButton = { type: 'LINK', id: LINK_ID, label: 'Book online', style: 'OUTLINE', url: 'https://example.co.zm/book' } as const;
const mapButton = { type: 'MAP', id: MAP_ID, label: 'Find us', style: 'OUTLINE', latitude: -15.4167, longitude: 28.2833 } as const;
const card = (...actions: ActionCard['actions']): ActionCard => ({ schema_version: 1, layout: 'VERTICAL_STACK', actions }) as ActionCard;

function row(overrides: Partial<AdHistoryAuditRow>): AdHistoryAuditRow {
  return {
    id: '42',
    occurred_at_text: '2026-10-06T08:15:00.000000Z',
    action: 'ad_created',
    changes: null,
    actor_full_name: 'Chanda Mwale',
    saved_card_content: null,
    previous_card_content: null,
    ...overrides,
  };
}

/** The values a history item must never carry. */
const SECRETS = ['+260977123456', '+260966000111', '977123456', 'Hello there', 'example.co.zm', '-15.4167', '28.2833'];

describe('describeAdHistoryEvent', () => {
  it('names who did it and when, and keeps a former team member nameless', () => {
    expect(describeAdHistoryEvent(row({ action: 'ad_upload_verified' }))).toEqual({
      id: '42',
      occurredAt: '2026-10-06T08:15:00.000000Z',
      actorName: 'Chanda Mwale',
      kind: 'audio_upload_checked',
    });
    expect(describeAdHistoryEvent(row({ action: 'ad_upload_verified', actor_full_name: null }))?.actorName).toBeNull();
  });

  it('reads the ad being created and an upload being restarted, with the file name', () => {
    const upload = { fileName: 'offer.mp3', contentType: 'audio/mpeg', sizeBytes: 2048 };
    expect(describeAdHistoryEvent(row({ action: 'ad_created', changes: { title: 'x', upload } }))).toMatchObject({ kind: 'ad_created', fileName: 'offer.mp3' });
    expect(describeAdHistoryEvent(row({ action: 'ad_upload_restarted', changes: { upload } }))).toMatchObject({ kind: 'audio_upload_restarted', fileName: 'offer.mp3' });
    expect(describeAdHistoryEvent(row({ action: 'ad_created', changes: null }))).toMatchObject({ fileName: null });
  });

  it('reads a refused upload and a rename', () => {
    expect(describeAdHistoryEvent(row({ action: 'ad_upload_refused', changes: { reason: 'not_the_declared_audio_format' } }))).toMatchObject({
      kind: 'audio_upload_refused',
      refusalReason: 'not_the_declared_audio_format',
    });
    expect(describeAdHistoryEvent(row({ action: 'ad_renamed', changes: { previousTitle: 'Summer', title: 'Summer service offer' } }))).toMatchObject({
      kind: 'ad_renamed',
      previousTitle: 'Summer',
      title: 'Summer service offer',
    });
  });

  it('a first save of buttons names each button added, by label and type', () => {
    const saved = card(callButton, whatsAppButton);
    const event = describeAdHistoryEvent(
      row({
        action: 'action_card_saved',
        changes: { adId: 'a', previousActionCardId: null, changedFields: [{ path: 'schema_version', change: 'added' }, { path: 'layout', change: 'added' }, { path: `actions.${CALL_ID}`, change: 'added' }, { path: `actions.${WHATSAPP_ID}`, change: 'added' }] },
        saved_card_content: saved,
      }),
    );
    expect(event).toMatchObject({
      kind: 'buttons_saved',
      isFirstSave: true,
      buttonChanges: [
        { buttonLabel: 'Call us', buttonType: 'CALL', change: 'added', changedFields: [] },
        { buttonLabel: 'Chat with us', buttonType: 'WHATSAPP', change: 'added', changedFields: [] },
      ],
    });
  });

  it('a change to one button says which part changed, never the value', () => {
    const previous = card(callButton, whatsAppButton);
    const saved = card(callButton, { ...whatsAppButton, phone_number_e164: '+260955000222', prefilled_text: 'Different words' });
    const event = describeAdHistoryEvent(
      row({
        action: 'action_card_saved',
        changes: { adId: 'a', previousActionCardId: 'previous', changedFields: [{ path: `actions.${WHATSAPP_ID}.phone_number_e164`, change: 'changed' }, { path: `actions.${WHATSAPP_ID}.prefilled_text`, change: 'changed' }] },
        saved_card_content: saved,
        previous_card_content: previous,
      }),
    );
    expect(event).toMatchObject({ isFirstSave: false, buttonChanges: [{ buttonLabel: 'Chat with us', buttonType: 'WHATSAPP', change: 'changed', changedFields: ['phone_number', 'whatsapp_message'] }] });
    for (const secret of [...SECRETS, '+260955000222', 'Different words']) expect(JSON.stringify(event), secret).not.toContain(secret);
  });

  it('names every kind of field by what it is (a link, a location, a label, a type, a place name)', () => {
    const saved = card(linkButton, mapButton);
    const event = describeAdHistoryEvent(
      row({
        action: 'action_card_saved',
        changes: { adId: 'a', previousActionCardId: 'p', changedFields: [
          { path: `actions.${LINK_ID}.url`, change: 'changed' }, { path: `actions.${LINK_ID}.label`, change: 'changed' },
          { path: `actions.${MAP_ID}.latitude`, change: 'changed' }, { path: `actions.${MAP_ID}.longitude`, change: 'changed' }, { path: `actions.${MAP_ID}.place_name`, change: 'added' },
        ] },
        saved_card_content: saved,
        previous_card_content: saved,
      }),
    );
    expect(event).toMatchObject({
      buttonChanges: [
        { buttonLabel: 'Book online', change: 'changed', changedFields: ['link', 'label'] },
        { buttonLabel: 'Find us', change: 'changed', changedFields: ['location', 'place_name'] },
      ],
    });
    expect(JSON.stringify(event)).not.toMatch(/example\.co\.zm|-15\.4167|28\.2833/);
  });

  it('a removed button is named from the card it was in, and a reordered one is "moved"', () => {
    const previous = card(callButton, whatsAppButton, linkButton);
    const saved = card(linkButton, callButton);
    const event = describeAdHistoryEvent(
      row({
        action: 'action_card_saved',
        changes: { adId: 'a', previousActionCardId: 'p', changedFields: [{ path: `actions.${CALL_ID}.position`, change: 'changed' }, { path: `actions.${CALL_ID}.style`, change: 'changed' }, { path: `actions.${WHATSAPP_ID}`, change: 'removed' }] },
        saved_card_content: saved,
        previous_card_content: previous,
      }),
    );
    expect(event).toMatchObject({
      buttonChanges: [
        { buttonLabel: 'Call us', change: 'moved', changedFields: [] },
        { buttonLabel: 'Chat with us', change: 'removed', changedFields: [] },
      ],
    });
  });

  it('a style-only change (which follows a button\'s position) is not worth a line of its own', () => {
    const saved = card(callButton);
    const event = describeAdHistoryEvent(
      row({ action: 'action_card_saved', changes: { adId: 'a', previousActionCardId: 'p', changedFields: [{ path: `actions.${CALL_ID}.style`, change: 'changed' }] }, saved_card_content: saved, previous_card_content: saved }),
    );
    expect(event).toMatchObject({ kind: 'buttons_saved', buttonChanges: [] });
  });

  it('a first schedule has no parts; a later one names the parts that differ, counting hours once however they changed', () => {
    const before = { startsOn: '2026-11-02', endsOn: '2026-11-30', timeWindows: [{ daysOfWeek: [1], localStartTime: '07:00', localEndTime: '09:00' }], gracePeriodMinutes: 10, engagementLimit: null };
    expect(describeAdHistoryEvent(row({ action: 'campaign_schedule_saved', changes: { adId: 'a', previousSchedule: null, schedule: before } }))).toMatchObject({
      kind: 'schedule_saved',
      isFirstSave: true,
      changedParts: [],
    });
    const after = { ...before, endsOn: '2026-12-15', timeWindows: [{ daysOfWeek: [1, 2], localStartTime: '07:00', localEndTime: '09:00' }], engagementLimit: 250 };
    expect(describeAdHistoryEvent(row({ action: 'campaign_schedule_saved', changes: { adId: 'a', previousSchedule: before, schedule: after } }))).toMatchObject({
      isFirstSave: false,
      changedParts: ['dates', 'hours', 'tap_limit'],
    });
    expect(describeAdHistoryEvent(row({ action: 'campaign_schedule_saved', changes: { adId: 'a', previousSchedule: before, schedule: { ...before, gracePeriodMinutes: 20 } } }))).toMatchObject({
      changedParts: ['grace_period'],
    });
    expect(describeAdHistoryEvent(row({ action: 'campaign_schedule_saved', changes: { adId: 'a', previousSchedule: before, schedule: { ...before } } }))).toMatchObject({ changedParts: [] });
  });

  it('publishing says whether it was the first time or an update to a live ad', () => {
    expect(describeAdHistoryEvent(row({ action: 'campaign_published', changes: { adId: 'a', previousStatus: 'DRAFT' } }))).toMatchObject({ kind: 'ad_published', isRepublish: false });
    expect(describeAdHistoryEvent(row({ action: 'campaign_published', changes: { adId: 'a', previousStatus: 'ACTIVE' } }))).toMatchObject({ isRepublish: true });
  });

  it('gives nothing for an audit row that is not part of an ad\'s history', () => {
    expect(describeAdHistoryEvent(row({ action: 'client_created' }))).toBeNull();
    expect(describeAdHistoryEvent(row({ action: 'signed_in' }))).toBeNull();
  });

  it('survives rows with missing or odd data without throwing', () => {
    expect(() => describeAdHistoryEvent(row({ action: 'action_card_saved', changes: { changedFields: 'not a list' } }))).not.toThrow();
    expect(() => describeAdHistoryEvent(row({ action: 'campaign_schedule_saved', changes: { previousSchedule: 'x', schedule: 4 } }))).not.toThrow();
    expect(describeAdHistoryEvent(row({ action: 'action_card_saved', changes: { previousActionCardId: 'p', changedFields: [{ path: `actions.${CALL_ID}.url`, change: 'changed' }] }, saved_card_content: null, previous_card_content: null }))).toMatchObject({
      buttonChanges: [],
    });
  });
});
