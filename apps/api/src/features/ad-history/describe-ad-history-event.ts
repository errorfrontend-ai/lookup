import type { ActionCard, AdHistoryEvent, ButtonChange, ScheduleChangedPart } from '@lookup/contracts';

/** The audit actions an ad's history is made of, and the only ones the history query asks for. */
export const AD_HISTORY_ACTIONS = [
  'ad_created',
  'ad_renamed',
  'ad_upload_restarted',
  'ad_upload_verified',
  'ad_upload_refused',
  'action_card_saved',
  'campaign_schedule_saved',
  'campaign_published',
] as const;

/** One audit row with the extras the history query joins on: who did it, and the card versions it refers to. */
export interface AdHistoryAuditRow {
  id: string;
  occurred_at_text: string;
  action: string;
  changes: Record<string, unknown> | null;
  actor_full_name: string | null;
  /** For a buttons save: the card as saved, and the card it replaced. */
  saved_card_content: ActionCard | null;
  previous_card_content: ActionCard | null;
}

type ButtonField = ButtonChange['changedFields'][number];

/** Which part of a button each stored field is, by name. Style follows the button's position, so it is not listed. */
const BUTTON_FIELD_NAMES: Record<string, ButtonField | undefined> = {
  type: 'type',
  label: 'label',
  phone_number_e164: 'phone_number',
  prefilled_text: 'whatsapp_message',
  url: 'link',
  latitude: 'location',
  longitude: 'location',
  place_name: 'place_name',
};

interface FieldChange {
  path: string;
  change: 'added' | 'removed' | 'changed';
}

/**
 * Turns one audit row into a history event, or null for a row that isn't part of an ad's history.
 *
 * The event names what changed, never the values: a changed WhatsApp number is "changed the WhatsApp
 * number of the button 'Chat with us'", with no number in it. Button labels and types are read from the
 * saved card versions here on the server, and the response carries only those and field names.
 */
export function describeAdHistoryEvent(row: AdHistoryAuditRow): AdHistoryEvent | null {
  const base = { id: row.id, occurredAt: row.occurred_at_text, actorName: row.actor_full_name };
  const changes = row.changes ?? {};
  switch (row.action) {
    case 'ad_created':
      return { ...base, kind: 'ad_created', fileName: readUploadFileName(changes) };
    case 'ad_renamed':
      return { ...base, kind: 'ad_renamed', previousTitle: String(changes.previousTitle ?? ''), title: String(changes.title ?? '') };
    case 'ad_upload_restarted':
      return { ...base, kind: 'audio_upload_restarted', fileName: readUploadFileName(changes) };
    case 'ad_upload_verified':
      return { ...base, kind: 'audio_upload_checked' };
    case 'ad_upload_refused':
      return { ...base, kind: 'audio_upload_refused', refusalReason: String(changes.reason ?? '') };
    case 'action_card_saved':
      return {
        ...base,
        kind: 'buttons_saved',
        isFirstSave: changes.previousActionCardId === null || changes.previousActionCardId === undefined,
        buttonChanges: describeButtonChanges(readFieldChanges(changes.changedFields), row.saved_card_content, row.previous_card_content),
      };
    case 'campaign_schedule_saved':
      return {
        ...base,
        kind: 'schedule_saved',
        isFirstSave: changes.previousSchedule === null || changes.previousSchedule === undefined,
        changedParts: describeScheduleChanges(changes.previousSchedule, changes.schedule),
      };
    case 'campaign_published':
      return { ...base, kind: 'ad_published', isRepublish: changes.previousStatus === 'ACTIVE' };
    default:
      return null;
  }
}

function readUploadFileName(changes: Record<string, unknown>): string | null {
  const upload = changes.upload;
  if (typeof upload === 'object' && upload !== null && 'fileName' in upload && typeof upload.fileName === 'string') return upload.fileName;
  return null;
}

function readFieldChanges(value: unknown): FieldChange[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is FieldChange =>
      typeof entry === 'object' && entry !== null && typeof entry.path === 'string' && ['added', 'removed', 'changed'].includes(entry.change),
  );
}

/** Groups the changed fields by button, and names each button from the card version it exists in. */
function describeButtonChanges(fieldChanges: FieldChange[], savedCard: ActionCard | null, previousCard: ActionCard | null): ButtonChange[] {
  const changesByButton = new Map<string, FieldChange[]>();
  for (const fieldChange of fieldChanges) {
    const [prefix, buttonId, field] = fieldChange.path.split('.');
    if (prefix !== 'actions' || !buttonId) continue;
    changesByButton.set(buttonId, [...(changesByButton.get(buttonId) ?? []), { path: field ?? '', change: fieldChange.change }]);
  }

  const buttonChanges: ButtonChange[] = [];
  for (const [buttonId, changesToButton] of changesByButton) {
    const savedButton = savedCard?.actions.find((action) => action.id === buttonId);
    const previousButton = previousCard?.actions.find((action) => action.id === buttonId);
    const button = savedButton ?? previousButton;
    if (!button) continue;
    const labelAndType = { buttonLabel: button.label, buttonType: button.type };

    const wholeButton = changesToButton.find((change) => change.path === '');
    if (wholeButton) {
      buttonChanges.push({ ...labelAndType, change: wholeButton.change === 'removed' ? 'removed' : 'added', changedFields: [] });
      continue;
    }
    const changedFields = [
      ...new Set(changesToButton.map((change) => BUTTON_FIELD_NAMES[change.path]).filter((name): name is ButtonField => name !== undefined)),
    ];
    if (changedFields.length > 0) buttonChanges.push({ ...labelAndType, change: 'changed', changedFields });
    else if (changesToButton.some((change) => change.path === 'position')) buttonChanges.push({ ...labelAndType, change: 'moved', changedFields: [] });
  }
  return buttonChanges;
}

/** Which parts of a schedule differ between two saved versions. */
function describeScheduleChanges(previous: unknown, next: unknown): ScheduleChangedPart[] {
  if (!isRecord(previous) || !isRecord(next)) return [];
  const parts: ScheduleChangedPart[] = [];
  if (previous.startsOn !== next.startsOn || previous.endsOn !== next.endsOn) parts.push('dates');
  if (JSON.stringify(previous.timeWindows) !== JSON.stringify(next.timeWindows)) parts.push('hours');
  if (previous.gracePeriodMinutes !== next.gracePeriodMinutes) parts.push('grace_period');
  if ((previous.engagementLimit ?? null) !== (next.engagementLimit ?? null)) parts.push('tap_limit');
  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
