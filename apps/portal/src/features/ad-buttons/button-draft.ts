import { ActionCard, type ActionStyle, formatPhoneNumberForDisplay, MAXIMUM_ACTIONS_PER_CARD } from '@lookup/contracts';

export const BUTTON_KINDS = ['CALL', 'WHATSAPP', 'MAP', 'LINK'] as const;
export type ButtonKind = (typeof BUTTON_KINDS)[number];

/** The things a person fills in for a button. Each problem found is tied to one of these. */
export type ButtonField = 'label' | 'phone' | 'firstMessage' | 'webAddress' | 'location' | 'placeName';

export { MAXIMUM_ACTIONS_PER_CARD as MAXIMUM_BUTTONS };

/**
 * One button as it is being edited: what the person typed, exactly as typed. Nothing here is checked
 * or tidied until the card is built (see validate-button-drafts.ts), so typing is never interrupted.
 * `key` is the button's id in the card: it stays the same when the button is edited, so taps keep
 * counting against the same button across versions.
 */
export interface ButtonDraft {
  key: string;
  kind: ButtonKind;
  label: string;
  /** Call and WhatsApp. */
  phoneText: string;
  /** WhatsApp: the message the chat opens with. */
  firstMessage: string;
  /** Website. */
  webAddressText: string;
  /** Directions: a pasted Google Maps link, or "latitude, longitude". */
  locationText: string;
  placeName: string;
}

/** The label a new button starts with, so it is never blank. */
export const STARTING_LABELS: Record<ButtonKind, string> = {
  CALL: 'Call us',
  WHATSAPP: 'Chat on WhatsApp',
  MAP: 'Get directions',
  LINK: 'Visit our website',
};

export function newButtonDraft(kind: ButtonKind, key: string = crypto.randomUUID()): ButtonDraft {
  return { key, kind, label: STARTING_LABELS[kind], phoneText: '', firstMessage: '', webAddressText: '', locationText: '', placeName: '' };
}

/** The first button is the main one; the second is quieter; the rest are outlined. */
export function styleForPosition(position: number): ActionStyle {
  return position === 0 ? 'PRIMARY' : position === 1 ? 'SECONDARY' : 'OUTLINE';
}

/**
 * The drafts for editing a saved card. A missing card is an empty list. A card this page does not
 * understand (a newer version, or anything that is not a card) returns null, and the page must not
 * offer to edit it: saving would drop whatever it could not read.
 */
export function draftsFromCard(card: unknown): ButtonDraft[] | null {
  if (card === null || card === undefined) return [];
  const parsed = ActionCard.safeParse(card);
  if (!parsed.success) return null;
  return parsed.data.actions.map((action): ButtonDraft => {
    const blank = { ...newButtonDraft(action.type, action.id), label: action.label };
    switch (action.type) {
      case 'CALL':
        return { ...blank, phoneText: formatPhoneNumberForDisplay(action.phone_number_e164) };
      case 'WHATSAPP':
        return { ...blank, phoneText: formatPhoneNumberForDisplay(action.phone_number_e164), firstMessage: action.prefilled_text ?? '' };
      case 'MAP':
        return { ...blank, locationText: `${action.latitude}, ${action.longitude}`, placeName: action.place_name ?? '' };
      case 'LINK':
        return { ...blank, webAddressText: action.url };
    }
  });
}

/** Moves one button a place up or down; at either end it stays where it is. */
export function moveDraft(drafts: readonly ButtonDraft[], key: string, direction: 'up' | 'down'): ButtonDraft[] {
  const index = drafts.findIndex((draft) => draft.key === key);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= drafts.length) return [...drafts];
  const moved = [...drafts];
  const [draft] = moved.splice(index, 1);
  moved.splice(target, 0, draft as ButtonDraft);
  return moved;
}
