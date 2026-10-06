import {
  ActionCard,
  CardAction,
  LinkAction,
  MapAction,
  MAXIMUM_ACTIONS_PER_CARD,
  normalizeZambianPhoneInput,
  reasonCodeForIssue,
  WhatsAppAction,
} from '@lookup/contracts';
import type { FieldProblem } from '../../api/api-client';
import {
  CARD_NOT_SAVABLE_PROBLEM,
  describeButtonProblem,
  FIELD_FOR_CARD_PROPERTY,
  NO_BUTTONS_PROBLEM,
  TOO_MANY_BUTTONS_PROBLEM,
} from '../../plain-words/button-words';
import { type ButtonDraft, type ButtonField, styleForPosition } from './button-draft';
import { parseMapLocation } from './parse-map-location';
import { readWebAddress } from './read-web-address';

/** Plain-words problems for one button, by the field they are about. */
export type ButtonFieldProblems = Partial<Record<ButtonField, string>>;

export interface ButtonValidation {
  /** The card to save: set only when there is at least one button, no more than six, and every one is right. */
  card: ActionCard | null;
  /** Problems by button (its draft key). A button with none is not in the map. */
  problemsByKey: ReadonlyMap<string, ButtonFieldProblems>;
  /** A problem with the card as a whole (no buttons, too many), or null. */
  cardProblem: string | null;
  /** The buttons that are right so far, for the live preview. A button with a problem is left out of it until it is fixed. */
  previewCard: { schema_version: 1; layout: 'VERTICAL_STACK'; actions: CardAction[] };
  /** The labels of the buttons left out of the preview, so it can say why. */
  hiddenFromPreview: string[];
  problemCount: number;
}

type IssueSource = { safeParse: (value: unknown) => { success: true } | { success: false; error: { issues: Array<Parameters<typeof reasonCodeForIssue>[0]> } } };

/** The code of the first thing wrong with a value, using the card's own rule for that field. */
function problemCodeFor(schema: IssueSource, value: unknown): string | null {
  const result = schema.safeParse(value);
  if (result.success) return null;
  const firstIssue = result.error.issues[0];
  return firstIssue ? reasonCodeForIssue(firstIssue) : 'custom';
}

function emptyToUndefined(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Reads one draft: the action it makes (when it is all right) and, in words, what is wrong (when it is not). */
function readDraft(draft: ButtonDraft, position: number): { action: CardAction | null; problems: ButtonFieldProblems } {
  const problems: ButtonFieldProblems = {};
  const flag = (field: ButtonField, code: string) => {
    problems[field] = describeButtonProblem(field, code);
  };

  const label = draft.label.trim();
  const labelProblem = problemCodeFor(LinkAction.shape.label, label);
  if (labelProblem) flag('label', labelProblem);

  const common = { id: draft.key, label, style: styleForPosition(position) };
  let action: CardAction | null = null;

  if (draft.kind === 'CALL' || draft.kind === 'WHATSAPP') {
    const phoneNumber = normalizeZambianPhoneInput(draft.phoneText);
    if (phoneNumber === null) flag('phone', draft.phoneText.trim() === '' ? 'empty' : 'unreadable');
    if (draft.kind === 'WHATSAPP') {
      const firstMessage = emptyToUndefined(draft.firstMessage);
      const messageProblem = firstMessage === undefined ? null : problemCodeFor(WhatsAppAction.shape.prefilled_text, firstMessage);
      if (messageProblem) flag('firstMessage', messageProblem);
      if (phoneNumber !== null) action = { type: 'WHATSAPP', ...common, phone_number_e164: phoneNumber, ...(firstMessage === undefined ? {} : { prefilled_text: firstMessage }) };
    } else if (phoneNumber !== null) {
      action = { type: 'CALL', ...common, phone_number_e164: phoneNumber };
    }
  } else if (draft.kind === 'MAP') {
    const location = parseMapLocation(draft.locationText);
    if (location.kind === 'problem') flag('location', location.problem);
    const placeName = emptyToUndefined(draft.placeName);
    const placeNameProblem = placeName === undefined ? null : problemCodeFor(MapAction.shape.place_name, placeName);
    if (placeNameProblem) flag('placeName', placeNameProblem);
    if (location.kind === 'found') action = { type: 'MAP', ...common, latitude: location.latitude, longitude: location.longitude, ...(placeName === undefined ? {} : { place_name: placeName }) };
  } else {
    const address = readWebAddress(draft.webAddressText);
    if (address.kind === 'problem') flag('webAddress', address.problem);
    else action = { type: 'LINK', ...common, url: address.url };
  }

  if (Object.keys(problems).length > 0) return { action: null, problems };

  // The card's own rules have the last word: anything the readers let through that it refuses is named here.
  const finalCheck = action ? CardAction.safeParse(action) : null;
  if (!finalCheck || finalCheck.success) return { action: action, problems };
  for (const issue of finalCheck.error.issues) {
    const field = FIELD_FOR_CARD_PROPERTY[String(issue.path[issue.path.length - 1] ?? '')] ?? (draft.kind === 'MAP' ? 'location' : 'label');
    if (!problems[field]) flag(field, reasonCodeForIssue(issue));
  }
  return { action: null, problems };
}

/**
 * Turns what the person has typed into the card to save, and says in words what is wrong with
 * anything that is not right. The readers (phone, web address, location) tidy what was typed; the
 * card's own rules from the contracts then check the result, so what passes here is what the API and
 * the listener app accept.
 */
export function validateButtonDrafts(drafts: readonly ButtonDraft[]): ButtonValidation {
  const problemsByKey = new Map<string, ButtonFieldProblems>();
  const actions: CardAction[] = [];
  const hiddenFromPreview: string[] = [];

  drafts.forEach((draft, position) => {
    const { action, problems } = readDraft(draft, position);
    if (action) actions.push(action);
    else {
      hiddenFromPreview.push(draft.label.trim() || `Button ${position + 1}`);
      if (Object.keys(problems).length > 0) problemsByKey.set(draft.key, problems);
    }
  });

  const problemCount = [...problemsByKey.values()].reduce((count, problems) => count + Object.keys(problems).length, 0);
  let cardProblem: string | null = null;
  if (drafts.length === 0) cardProblem = NO_BUTTONS_PROBLEM;
  else if (drafts.length > MAXIMUM_ACTIONS_PER_CARD) cardProblem = TOO_MANY_BUTTONS_PROBLEM;

  let card: ActionCard | null = null;
  if (cardProblem === null && hiddenFromPreview.length === 0) {
    const candidate = ActionCard.safeParse({ schema_version: 1, layout: 'VERTICAL_STACK', actions });
    if (candidate.success) card = candidate.data;
    else cardProblem = CARD_NOT_SAVABLE_PROBLEM;
  }

  return {
    card,
    problemsByKey,
    cardProblem,
    previewCard: { schema_version: 1, layout: 'VERTICAL_STACK', actions: actions.slice(0, MAXIMUM_ACTIONS_PER_CARD) },
    hiddenFromPreview,
    problemCount,
  };
}

/**
 * The problems the API reported for a save (it checks the same card rules), tied back to the buttons
 * they are about. Paths look like "actions.1.phone_number_e164"; anything else is ignored, and the
 * screen shows the API's own message and reference instead.
 */
export function problemsFromApiFields(drafts: readonly ButtonDraft[], fields: readonly FieldProblem[]): ReadonlyMap<string, ButtonFieldProblems> {
  const problemsByKey = new Map<string, ButtonFieldProblems>();
  for (const { path, code } of fields) {
    const match = /^actions\.(\d+)\.([a-z_0-9]+)$/.exec(path);
    const draft = match ? drafts[Number(match[1])] : undefined;
    const field = match ? FIELD_FOR_CARD_PROPERTY[match[2] as string] : undefined;
    if (!draft || !field) continue;
    problemsByKey.set(draft.key, { ...problemsByKey.get(draft.key), [field]: describeButtonProblem(field, code) });
  }
  return problemsByKey;
}
