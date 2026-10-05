import { ACTION_CARD_SCHEMA_VERSION, MAXIMUM_ACTIONS_PER_CARD } from './action-card-schema.js';
import type { ActionStyle } from './action-card-schema.js';

/**
 * The tolerant reader: how anything that SHOWS a card (the listener app, the portal's live preview)
 * reads it. A card written for a newer app must never crash an older one, so the reader follows
 * fixed rules (the listener app implements the same rules and is tested on the same fixtures):
 *
 *  R1 skip an unknown action type;
 *  R2 ignore unknown fields;
 *  R3 treat an unknown or missing style as SECONDARY;
 *  R4 treat an unknown layout as VERTICAL_STACK;
 *  R5 skip a known type whose fields are unusable (phone not E.164, link not canonical https,
 *     coordinates out of range, missing label or id); an unusable optional field is dropped instead;
 *  R6 show at most 6 actions, keep the first of any duplicate ids, put actions beyond 4 under "More options";
 *  R7 if schema_version is not an integer or is newer than this reader supports, show no actions
 *     and the "update the app" hint;
 *  R8 if nothing can be shown and at least one action was an unknown type, show the same hint
 *     (actions skipped only because they were invalid do not trigger it);
 *  R9 never throw: anything that is not a card reads as a card with no actions.
 *
 * Labels are never cut here; the app shows long ones with an ellipsis and the full text for screen readers.
 */
export const ACTIONS_SHOWN_BEFORE_MORE_OPTIONS = 4;

export type ReadAction =
  | { type: 'LINK'; id: string; label: string; style: ActionStyle; url: string }
  | { type: 'CALL'; id: string; label: string; style: ActionStyle; phoneNumberE164: string }
  | { type: 'WHATSAPP'; id: string; label: string; style: ActionStyle; phoneNumberE164: string; prefilledText?: string }
  | { type: 'MAP'; id: string; label: string; style: ActionStyle; latitude: number; longitude: number; placeName?: string };

export interface ReadActionCard {
  layout: 'VERTICAL_STACK';
  /** Shown as buttons, in order. */
  visibleActions: ReadAction[];
  /** Shown under "More options". */
  moreOptionsActions: ReadAction[];
  skippedUnknownTypeCount: number;
  skippedInvalidCount: number;
  showsUpdateAppHint: boolean;
}

const KNOWN_STYLES: readonly ActionStyle[] = ['PRIMARY', 'SECONDARY', 'OUTLINE'];
const PHONE_NUMBER_E164 = /^\+[1-9][0-9]{6,14}$/;
const HTTPS_LINK =
  /^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9](?:[\/?#][\x21-\x7E]*)?$/;

export function readActionCard(card: unknown, supportedSchemaVersion: number = ACTION_CARD_SCHEMA_VERSION): ReadActionCard {
  const emptyCard = (showsUpdateAppHint: boolean): ReadActionCard => ({
    layout: 'VERTICAL_STACK',
    visibleActions: [],
    moreOptionsActions: [],
    skippedUnknownTypeCount: 0,
    skippedInvalidCount: 0,
    showsUpdateAppHint,
  });
  if (!isPlainObject(card)) return emptyCard(false);
  const schemaVersion = card.schema_version;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion > supportedSchemaVersion) {
    return emptyCard(true);
  }
  const rawActions = Array.isArray(card.actions) ? card.actions : [];

  const readableActions: ReadAction[] = [];
  const seenActionIds = new Set<string>();
  let skippedUnknownTypeCount = 0;
  let skippedInvalidCount = 0;
  for (const rawAction of rawActions) {
    const outcome = readAction(rawAction);
    if (outcome === 'unknown-type') skippedUnknownTypeCount++;
    else if (outcome === 'invalid') skippedInvalidCount++;
    else if (!seenActionIds.has(outcome.id)) {
      seenActionIds.add(outcome.id);
      readableActions.push(outcome);
    }
  }
  const shownActions = readableActions.slice(0, MAXIMUM_ACTIONS_PER_CARD);
  return {
    layout: 'VERTICAL_STACK',
    visibleActions: shownActions.slice(0, ACTIONS_SHOWN_BEFORE_MORE_OPTIONS),
    moreOptionsActions: shownActions.slice(ACTIONS_SHOWN_BEFORE_MORE_OPTIONS),
    skippedUnknownTypeCount,
    skippedInvalidCount,
    showsUpdateAppHint: shownActions.length === 0 && skippedUnknownTypeCount > 0,
  };
}

function readAction(rawAction: unknown): ReadAction | 'unknown-type' | 'invalid' {
  if (!isPlainObject(rawAction)) return 'invalid';
  const { type, id, label } = rawAction;
  if (type !== 'LINK' && type !== 'CALL' && type !== 'WHATSAPP' && type !== 'MAP') {
    return typeof type === 'string' ? 'unknown-type' : 'invalid';
  }
  if (!isNonEmptyText(id) || !isNonEmptyText(label)) return 'invalid';
  const style = KNOWN_STYLES.includes(rawAction.style as ActionStyle) ? (rawAction.style as ActionStyle) : 'SECONDARY';
  const common = { id, label, style };

  switch (type) {
    case 'LINK': {
      const url = rawAction.url;
      return typeof url === 'string' && isCanonicalHttpsLink(url) ? { type, ...common, url } : 'invalid';
    }
    case 'CALL': {
      const phoneNumberE164 = rawAction.phone_number_e164;
      return isPhoneNumberE164(phoneNumberE164) ? { type, ...common, phoneNumberE164 } : 'invalid';
    }
    case 'WHATSAPP': {
      const phoneNumberE164 = rawAction.phone_number_e164;
      if (!isPhoneNumberE164(phoneNumberE164)) return 'invalid';
      const prefilledText = isNonEmptyText(rawAction.prefilled_text) ? rawAction.prefilled_text : undefined;
      return prefilledText ? { type, ...common, phoneNumberE164, prefilledText } : { type, ...common, phoneNumberE164 };
    }
    case 'MAP': {
      const { latitude, longitude } = rawAction;
      if (!isNumberBetween(latitude, -90, 90) || !isNumberBetween(longitude, -180, 180)) return 'invalid';
      const placeName = isNonEmptyText(rawAction.place_name) ? rawAction.place_name : undefined;
      return placeName ? { type, ...common, latitude, longitude, placeName } : { type, ...common, latitude, longitude };
    }
  }
}

export function isCanonicalHttpsLink(url: string): boolean {
  if (!HTTPS_LINK.test(url)) return false;
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'https:' && parsedUrl.username === '' && parsedUrl.password === '' && parsedUrl.href === url;
  } catch {
    return false;
  }
}

function isPhoneNumberE164(value: unknown): value is string {
  return typeof value === 'string' && PHONE_NUMBER_E164.test(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNumberBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
