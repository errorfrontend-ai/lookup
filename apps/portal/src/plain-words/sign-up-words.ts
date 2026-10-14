import type { ApplicationStep } from '@lookup/contracts';
import { ApiError } from '../api/api-client';

/** The sign-up steps' names, as the wireframes write them (P5A design §4.2). */
export const SIGN_UP_STEP_NAMES: Record<ApplicationStep, string> = {
  account: 'Your account',
  verify: 'Verify',
  details: 'Station details',
  licence: 'Licence',
};

export const SIGN_UP_STEP_NUMBERS: Record<ApplicationStep, number> = { account: 1, verify: 2, details: 3, licence: 4 };

/**
 * A field's reason code from the API (or the contracts' own checks), in plain words. Every code the sign-up routes
 * answer with has its words; anything else falls back to a general sentence, never the code.
 */
const FIELD_REASON_WORDS: Record<string, string> = {
  // zod's own codes (reasonCodeForIssue passes them through).
  invalid_type: 'This is needed.',
  too_small: 'This is needed, or too short.',
  too_big: 'This is too long.',
  invalid_value: 'Choose one from the list.',
  invalid_format: "This doesn't look right. Check it and try again.",
  // The password policy's (P5A-SIGNUP-05).
  too_short: 'Use at least 15 characters.',
  too_long: 'Use at most 128 characters.',
  not_a_zambian_mobile_number: 'Enter a Zambian mobile number, for example 97 123 4567.',
  not_https: 'Use a link that starts with https://.',
  unknown_time_zone: 'Choose a time zone from the list.',
  too_common: 'This password is too easy to guess. Choose a longer or less common one.',
  contains_personal_details: "Don't use your name, email or station name in the password.",
  wrong_file_type: "This file type isn't accepted here.",
  file_too_large: 'This file is too large.',
  image_too_small: 'This picture is too small: it needs to be at least 64 × 64 pixels.',
  image_unreadable: "We couldn't read this picture. Try another one.",
  upload_not_received: "The file didn't arrive. Choose it again.",
  nothing_changed: 'Change at least one thing first.',
};

export function fieldReasonWords(code: string, fallback = "This doesn't look right. Check it and try again."): string {
  return FIELD_REASON_WORDS[code] ?? fallback;
}

/** Field problems from the API, by field, in plain words. */
export function fieldErrorsFrom(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  return Object.fromEntries(error.fields.map((field) => [field.path, fieldReasonWords(field.code)]));
}

/** Why an application cannot be submitted yet (APPLICATION_INCOMPLETE's fields), with where it is fixed. */
export const MISSING_PART_WORDS: Record<string, { words: string; step: ApplicationStep }> = {
  station_details_missing: { words: "Your station's name, frequency, province and town", step: 'details' },
  licence_number_missing: { words: 'Your licence number', step: 'licence' },
  licence_document_missing: { words: 'Your licence document', step: 'licence' },
  phone_not_verified: { words: 'The code we texted to your phone', step: 'verify' },
  email_not_verified: { words: 'The link we emailed you', step: 'verify' },
};
