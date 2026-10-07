import { z } from 'zod';
import { isUrlShortenerHost } from './url-shortener-hosts.js';

/**
 * The action card: the buttons a listener sees after identifying an ad. Written once here and used
 * by the API (validation), the portal (live preview, form errors) and, through the emitted JSON
 * Schema in schemas/action-card.schema.json, the listener app.
 *
 * Wire names are snake_case and written in full, like the database columns and the error envelope.
 */
export const ACTION_CARD_SCHEMA_VERSION = 1;
export const MAXIMUM_ACTIONS_PER_CARD = 6;
/** Counted in Unicode code points (zod and JSON Schema agree; Dart must use `runes.length`). */
export const MAXIMUM_LABEL_LENGTH = 32;
export const MAXIMUM_PREFILLED_TEXT_LENGTH = 500;
/** Google Maps and most browsers cap URLs at 2,048 characters. */
export const MAXIMUM_LINK_URL_LENGTH = 2048;
export const MAXIMUM_PLACE_NAME_LENGTH = 80;

// Every pattern stays in the subset that JavaScript, Python `re` and Dart `RegExp` treat the same:
// no flags (zod drops them when emitting JSON Schema), no lookaround, no \p{...} classes.
const NO_SURROUNDING_WHITESPACE = /^\S(?:[\s\S]*\S)?$/;
// Control characters, zero-width characters and bidirectional overrides (Trojan Source) are refused.
const NO_CONTROL_OR_INVISIBLE_CHARACTERS =
  /^[^\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]*$/;
const NO_CONTROL_CHARACTERS_EXCEPT_LINE_BREAKS =
  /^[^\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]*$/;
// https, a dotted ASCII host whose last label starts with a letter (so no IP addresses, no localhost,
// no user:password@, no port), then visible ASCII only. The portal turns international domain names
// into punycode (new URL(input).href) before saving, so a lookalike host shows as xn--… in the app.
const HTTPS_LINK =
  /^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9](?:[\/?#][\x21-\x7E]*)?$/;
// The same rule as the portal_users_phone_number_check constraint in the database.
const PHONE_NUMBER_E164 = /^\+[1-9][0-9]{6,14}$/;
const ZAMBIAN_PHONE_NUMBER_E164 = /^\+260[1-9][0-9]{8}$/;

/**
 * Rules JSON Schema cannot express. They are checked by zod only, and their reason codes are relayed
 * to the caller in VALIDATION_FAILED (see VALIDATION_REASON_CODES).
 */
export const ACTION_CARD_RULE_REASONS = [
  'duplicate_action_id',
  'zambian_number_must_have_nine_digits',
  'map_location_is_zero_zero',
  'link_must_be_canonical_https',
  'link_uses_url_shortener',
] as const;
export type ActionCardRuleReason = (typeof ACTION_CARD_RULE_REASONS)[number];

const singleLineText = (maximumLength: number) =>
  z.string().min(1).max(maximumLength).regex(NO_SURROUNDING_WHITESPACE).regex(NO_CONTROL_OR_INVISIBLE_CHARACTERS);

export const ActionStyle = z.enum(['PRIMARY', 'SECONDARY', 'OUTLINE']).meta({ id: 'ActionStyle' });
export const CardLayout = z.enum(['VERTICAL_STACK']).meta({ id: 'CardLayout' });
export const PhoneNumberE164 = z.string().regex(PHONE_NUMBER_E164).meta({
  id: 'PhoneNumberE164',
  description: 'E.164: "+", the country code, then the number; digits only, no spaces',
});

const commonActionFields = {
  id: z.uuid().meta({ description: 'Stable for a button across card versions; taps are counted against it' }),
  label: singleLineText(MAXIMUM_LABEL_LENGTH).meta({ id: 'ActionLabel' }),
  style: ActionStyle,
};

export const LinkAction = z
  .strictObject({
    type: z.literal('LINK'),
    ...commonActionFields,
    url: z.string().max(MAXIMUM_LINK_URL_LENGTH).regex(HTTPS_LINK),
  })
  .meta({ id: 'LinkAction' });

export const CallAction = z
  .strictObject({
    type: z.literal('CALL'),
    ...commonActionFields,
    phone_number_e164: PhoneNumberE164,
  })
  .meta({ id: 'CallAction' });

export const WhatsAppAction = z
  .strictObject({
    type: z.literal('WHATSAPP'),
    ...commonActionFields,
    phone_number_e164: PhoneNumberE164,
    prefilled_text: z
      .string()
      .min(1)
      .max(MAXIMUM_PREFILLED_TEXT_LENGTH)
      .regex(NO_SURROUNDING_WHITESPACE)
      .regex(NO_CONTROL_CHARACTERS_EXCEPT_LINE_BREAKS)
      .optional(),
  })
  .meta({ id: 'WhatsAppAction' });

export const MapAction = z
  .strictObject({
    type: z.literal('MAP'),
    ...commonActionFields,
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    place_name: singleLineText(MAXIMUM_PLACE_NAME_LENGTH).optional(),
  })
  .meta({ id: 'MapAction' });

export const CardAction = z
  .discriminatedUnion('type', [LinkAction, CallAction, WhatsAppAction, MapAction])
  .meta({ id: 'CardAction' });

export const ActionCard = z
  .strictObject({
    schema_version: z.literal(ACTION_CARD_SCHEMA_VERSION),
    layout: CardLayout,
    actions: z.array(CardAction).min(1).max(MAXIMUM_ACTIONS_PER_CARD),
  })
  .superRefine((card, context) => {
    const seenActionIds = new Set<string>();
    card.actions.forEach((action, actionIndex) => {
      const reject = (path: Array<string | number>, reason: ActionCardRuleReason) =>
        context.addIssue({ code: 'custom', path: ['actions', actionIndex, ...path], params: { reason }, message: reason });
      if (seenActionIds.has(action.id)) reject(['id'], 'duplicate_action_id');
      seenActionIds.add(action.id);
      if (
        (action.type === 'CALL' || action.type === 'WHATSAPP') &&
        action.phone_number_e164.startsWith('+260') &&
        !ZAMBIAN_PHONE_NUMBER_E164.test(action.phone_number_e164)
      ) {
        reject(['phone_number_e164'], 'zambian_number_must_have_nine_digits');
      }
      if (action.type === 'MAP' && action.latitude === 0 && action.longitude === 0) {
        reject([], 'map_location_is_zero_zero');
      }
      if (action.type === 'LINK') {
        const parsedUrl = parseCanonicalHttpsUrl(action.url);
        if (!parsedUrl) reject(['url'], 'link_must_be_canonical_https');
        else if (isUrlShortenerHost(parsedUrl.hostname)) reject(['url'], 'link_uses_url_shortener');
      }
    });
  })
  .meta({ id: 'ActionCard', title: 'Look Up action card, schema version 1' });

export type ActionCard = z.infer<typeof ActionCard>;
export type CardAction = z.infer<typeof CardAction>;
export type ActionStyle = z.infer<typeof ActionStyle>;

/** The URL, parsed, when it is https, carries no credentials and is already in canonical form; else null. */
function parseCanonicalHttpsUrl(value: string): URL | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value); // try/catch rather than URL.canParse, so older Safari works in the portal
  } catch {
    return null;
  }
  const isCanonical =
    parsedUrl.protocol === 'https:' && parsedUrl.username === '' && parsedUrl.password === '' && parsedUrl.href === value;
  return isCanonical ? parsedUrl : null;
}

/** JSON Schema for the listener app and any other non-TypeScript reader. Refinements are not included. */
export function emitActionCardJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://contracts.lookup.invalid/action-card/1.json',
    ...z.toJSONSchema(ActionCard, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }),
  };
}
