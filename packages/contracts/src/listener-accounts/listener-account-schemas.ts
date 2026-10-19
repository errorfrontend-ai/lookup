import { z } from 'zod';

/**
 * Listener accounts (ADR-005, docs/design/listener-accounts.md): a listener gives an email, a gender and an
 * age to see the result of an ad scan, so stations can see which groups follow an advert. The email is proved
 * with a 6-digit code sent to it; there is no password.
 */

/** What a listener says about themselves; the dashboard shows groups of these, never a person. */
export const LISTENER_GENDERS = ['FEMALE', 'MALE', 'ANOTHER', 'PREFER_NOT_TO_SAY'] as const;
export type ListenerGender = (typeof LISTENER_GENDERS)[number];

/** Younger than this cannot create an account; older than the maximum is not accepted as an age. */
export const MINIMUM_LISTENER_AGE = 13;
export const MAXIMUM_LISTENER_AGE = 99;

/**
 * The version of the consent line the sign-up shows (LA-D8). The account keeps the version and the time it was
 * agreed; the server accepts only this one. Change it when the wording changes.
 */
export const LISTENER_CONSENT_TEXT_VERSION = 'listener-consent-2026-10';

/** The email code works like the station's SMS code: 6 digits, 10 minutes, 5 tries, one every 60 seconds. */
export const LISTENER_EMAIL_CODE_LENGTH = 6;
export const LISTENER_EMAIL_CODE_LIFETIME_SECONDS = 10 * 60;
export const LISTENER_EMAIL_CODE_RESEND_COOLDOWN_SECONDS = 60;
export const LISTENER_EMAIL_CODE_ATTEMPT_LIMIT = 5;

/** After a right code for a new email, the listener has this long to finish creating the account. */
export const LISTENER_ACCOUNT_TICKET_LIFETIME_SECONDS = 10 * 60;

export const MAXIMUM_LISTENER_EMAIL_LENGTH = 254;

/** An email as typed: trimmed, a real-looking address, and lower-cased so one address is one account. */
export const ListenerEmailAddress = z
  .string()
  .trim()
  .min(3)
  .max(MAXIMUM_LISTENER_EMAIL_LENGTH)
  .pipe(z.email())
  .transform((email) => email.toLowerCase());

const ListenerEmailCode = z.string().regex(/^[0-9]{6}$/);
const ListenerAccountTicket = z.string().regex(/^[A-Za-z0-9_-]{20,300}$/);

/** POST /api/v1/listener-account/code: send a code to this email. */
export const RequestListenerAccountCodeInput = z.strictObject({ email: ListenerEmailAddress }).meta({ id: 'RequestListenerAccountCodeInput' });
export type RequestListenerAccountCodeInput = z.output<typeof RequestListenerAccountCodeInput>;

/** POST /api/v1/listener-account/verify: the code that came to the email. */
export const VerifyListenerAccountCodeInput = z
  .strictObject({ email: ListenerEmailAddress, code: ListenerEmailCode })
  .meta({ id: 'VerifyListenerAccountCodeInput' });
export type VerifyListenerAccountCodeInput = z.output<typeof VerifyListenerAccountCodeInput>;

/**
 * POST /api/v1/listener-account: create the account, with the ticket a right code for a new email gave.
 * An age under MINIMUM_LISTENER_AGE passes this shape and is answered ACCOUNT_AGE_TOO_YOUNG; one above the maximum
 * is a validation failure naming `age`.
 */
export const CreateListenerAccountInput = z
  .strictObject({
    email: ListenerEmailAddress,
    ticket: ListenerAccountTicket,
    gender: z.enum(LISTENER_GENDERS),
    age: z.number().int().min(1).max(MAXIMUM_LISTENER_AGE),
    consent_text_version: z.literal(LISTENER_CONSENT_TEXT_VERSION),
  })
  .meta({ id: 'CreateListenerAccountInput' });
export type CreateListenerAccountInput = z.output<typeof CreateListenerAccountInput>;

/** 202 for a code request: when another may be asked for. The answer is the same for a known and an unknown email. */
export const ListenerAccountCodeSent = z
  .strictObject({ resend_after_seconds: z.number().int().min(1).max(3_600) })
  .meta({ id: 'ListenerAccountCodeSent' });
export type ListenerAccountCodeSent = z.infer<typeof ListenerAccountCodeSent>;

/** Only a masked form of the email ever comes back ("a***@gmail.com"). */
const MaskedEmail = z.string().min(3).max(MAXIMUM_LISTENER_EMAIL_LENGTH);

/** The answer to a right code, or to creating the account: this install now has an account. */
export const ListenerAccountSignedIn = z
  .strictObject({ status: z.literal('SIGNED_IN'), email_masked: MaskedEmail })
  .meta({ id: 'ListenerAccountSignedIn' });
export type ListenerAccountSignedIn = z.infer<typeof ListenerAccountSignedIn>;

/** A right code for an email with no account yet: the listener now gives gender and age, with this ticket. */
export const ListenerAccountDetailsNeeded = z
  .strictObject({ status: z.literal('DETAILS_NEEDED'), ticket: ListenerAccountTicket })
  .meta({ id: 'ListenerAccountDetailsNeeded' });
export type ListenerAccountDetailsNeeded = z.infer<typeof ListenerAccountDetailsNeeded>;

export const VerifyListenerAccountCodeAnswer = z
  .discriminatedUnion('status', [ListenerAccountSignedIn, ListenerAccountDetailsNeeded])
  .meta({ id: 'VerifyListenerAccountCodeAnswer' });
export type VerifyListenerAccountCodeAnswer = z.infer<typeof VerifyListenerAccountCodeAnswer>;

/** GET /api/v1/listener-account: for Settings. */
export const ListenerAccountSummary = z
  .strictObject({ is_signed_in: z.boolean(), email_masked: MaskedEmail.nullable() })
  .meta({ id: 'ListenerAccountSummary' });
export type ListenerAccountSummary = z.infer<typeof ListenerAccountSummary>;

/** The age bands the dashboard groups listeners into (LA-D9), from the stored birth year. */
export const LISTENER_AGE_BANDS = ['UNDER_18', 'AGE_18_TO_24', 'AGE_25_TO_34', 'AGE_35_TO_44', 'AGE_45_TO_54', 'AGE_55_AND_OVER'] as const;
export type ListenerAgeBand = (typeof LISTENER_AGE_BANDS)[number];

/** The age band of a listener born in `birthYear`, judged in `currentYear`. */
export function ageBandOf(birthYear: number, currentYear: number): ListenerAgeBand {
  const age = currentYear - birthYear;
  if (age < 18) return 'UNDER_18';
  if (age <= 24) return 'AGE_18_TO_24';
  if (age <= 34) return 'AGE_25_TO_34';
  if (age <= 44) return 'AGE_35_TO_44';
  if (age <= 54) return 'AGE_45_TO_54';
  return 'AGE_55_AND_OVER';
}

function emitInputJsonSchema(schema: z.ZodType, name: string): Record<string, unknown> {
  return { $id: `https://contracts.lookup.invalid/${name}/1.json`, ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }) };
}

function emitOutputJsonSchema(schema: z.ZodType, name: string): Record<string, unknown> {
  return { $id: `https://contracts.lookup.invalid/${name}/1.json`, ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output', unrepresentable: 'throw' }) };
}

/** For the listener app, which checks every body it builds and every answer it reads against the contract. */
export const emitRequestListenerAccountCodeInputJsonSchema = () => emitInputJsonSchema(RequestListenerAccountCodeInput, 'request-listener-account-code-input');
export const emitVerifyListenerAccountCodeInputJsonSchema = () => emitInputJsonSchema(VerifyListenerAccountCodeInput, 'verify-listener-account-code-input');
export const emitCreateListenerAccountInputJsonSchema = () => emitInputJsonSchema(CreateListenerAccountInput, 'create-listener-account-input');
export const emitListenerAccountCodeSentJsonSchema = () => emitOutputJsonSchema(ListenerAccountCodeSent, 'listener-account-code-sent');
export const emitVerifyListenerAccountCodeAnswerJsonSchema = () => emitOutputJsonSchema(VerifyListenerAccountCodeAnswer, 'verify-listener-account-code-answer');
export const emitListenerAccountSignedInJsonSchema = () => emitOutputJsonSchema(ListenerAccountSignedIn, 'listener-account-signed-in');
export const emitListenerAccountSummaryJsonSchema = () => emitOutputJsonSchema(ListenerAccountSummary, 'listener-account-summary');
