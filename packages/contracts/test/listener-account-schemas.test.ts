import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ageBandOf,
  CreateListenerAccountInput,
  LISTENER_AGE_BANDS,
  LISTENER_CONSENT_TEXT_VERSION,
  LISTENER_GENDERS,
  ListenerAccountSummary,
  RequestListenerAccountCodeInput,
  VerifyListenerAccountCodeAnswer,
  VerifyListenerAccountCodeInput,
} from '../src/listener-accounts/listener-account-schemas.js';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => {
  compile: (schema: unknown) => (data: unknown) => boolean;
};
const committedSchema = (fileName: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'schemas', fileName), 'utf8')) as unknown;

const ticket = 'A'.repeat(43);
const validCreation = { email: 'listener@example.com', ticket, gender: 'FEMALE', age: 30, consent_text_version: LISTENER_CONSENT_TEXT_VERSION };

describe('listener account requests (LA-ACCOUNT-01, -02, -05)', () => {
  it('reads an email trimmed and lower-cased, so one address is one account', () => {
    expect(RequestListenerAccountCodeInput.parse({ email: '  Listener@Example.COM ' })).toEqual({ email: 'listener@example.com' });
  });

  it.each(['', 'listener', 'listener@', 'a b@example.com', `${'a'.repeat(250)}@example.com`])('refuses the email %j', (email) => {
    expect(RequestListenerAccountCodeInput.safeParse({ email }).success).toBe(false);
  });

  it('refuses any field it does not know, so a body cannot carry more than it should', () => {
    expect(RequestListenerAccountCodeInput.safeParse({ email: 'a@example.com', gender: 'MALE' }).success).toBe(false);
    expect(VerifyListenerAccountCodeInput.safeParse({ email: 'a@example.com', code: '123456', age: 30 }).success).toBe(false);
  });

  it.each([
    ['123456', true],
    ['000000', true],
    ['12345', false],
    ['1234567', false],
    ['12345a', false],
    [' 123456', false],
    ['', false],
  ])('the code %j is accepted: %s', (code, accepted) => {
    expect(VerifyListenerAccountCodeInput.safeParse({ email: 'a@example.com', code }).success).toBe(accepted);
  });

  it('creates an account only with a ticket, one of the four genders, a whole age up to 99 and the current consent wording', () => {
    expect(CreateListenerAccountInput.safeParse(validCreation).success).toBe(true);
    for (const gender of LISTENER_GENDERS) expect(CreateListenerAccountInput.safeParse({ ...validCreation, gender }).success, gender).toBe(true);
    const refused: Array<[string, Record<string, unknown>]> = [
      ['an unknown gender', { gender: 'X' }],
      ['a lower-case gender', { gender: 'female' }],
      ['age 100', { age: 100 }],
      ['age 30.5', { age: 30.5 }],
      ['age as text', { age: '30' }],
      ['age 0', { age: 0 }],
      ['no ticket', { ticket: undefined }],
      ['a short ticket', { ticket: 'abc' }],
      ['old consent wording', { consent_text_version: 'listener-consent-2025-01' }],
      ['no consent wording', { consent_text_version: undefined }],
      ['an extra field', { listener_install_id: '0192a6c4-1111-4000-8000-000000000001' }],
    ];
    for (const [why, changes] of refused) expect(CreateListenerAccountInput.safeParse({ ...validCreation, ...changes }).success, why).toBe(false);
  });

  it('lets an age under 13 through the shape (the server answers ACCOUNT_AGE_TOO_YOUNG) but not one above 99', () => {
    expect(CreateListenerAccountInput.safeParse({ ...validCreation, age: 12 }).success).toBe(true);
    expect(CreateListenerAccountInput.safeParse({ ...validCreation, age: 13 }).success).toBe(true);
    expect(CreateListenerAccountInput.safeParse({ ...validCreation, age: 99 }).success).toBe(true);
    expect(CreateListenerAccountInput.safeParse({ ...validCreation, age: 100 }).success).toBe(false);
  });
});

describe('listener account answers (LA-ACCOUNT-03, -11)', () => {
  it('is either signed in with a masked email or in need of details with a ticket, and nothing else', () => {
    expect(VerifyListenerAccountCodeAnswer.safeParse({ status: 'SIGNED_IN', email_masked: 'l***@example.com' }).success).toBe(true);
    expect(VerifyListenerAccountCodeAnswer.safeParse({ status: 'DETAILS_NEEDED', ticket }).success).toBe(true);
    expect(VerifyListenerAccountCodeAnswer.safeParse({ status: 'SIGNED_IN', email_masked: 'l***@example.com', ticket }).success).toBe(false);
    expect(VerifyListenerAccountCodeAnswer.safeParse({ status: 'DETAILS_NEEDED' }).success).toBe(false);
    expect(VerifyListenerAccountCodeAnswer.safeParse({ status: 'SIGNED_IN', email: 'listener@example.com' }).success).toBe(false);
  });

  it('the summary for Settings has no gender, age or full email', () => {
    expect(ListenerAccountSummary.safeParse({ is_signed_in: true, email_masked: 'l***@example.com' }).success).toBe(true);
    expect(ListenerAccountSummary.safeParse({ is_signed_in: false, email_masked: null }).success).toBe(true);
    expect(ListenerAccountSummary.safeParse({ is_signed_in: true, email_masked: 'l***@example.com', gender: 'FEMALE' }).success).toBe(false);
  });

  it('the committed JSON Schemas agree with zod on a good and a bad body', () => {
    const validateCreation = new Ajv2020({ strict: true, allErrors: true, formats: { email: true } }).compile(committedSchema('create-listener-account-input.schema.json'));
    expect(validateCreation(validCreation)).toBe(true);
    expect(validateCreation({ ...validCreation, age: 100 })).toBe(false);
    expect(validateCreation({ ...validCreation, gender: 'X' })).toBe(false);
    expect(validateCreation({ ...validCreation, extra: true })).toBe(false);
    const validateAnswer = new Ajv2020({ strict: true, allErrors: true }).compile(committedSchema('verify-listener-account-code-answer.schema.json'));
    expect(validateAnswer({ status: 'DETAILS_NEEDED', ticket })).toBe(true);
    expect(validateAnswer({ status: 'DETAILS_NEEDED' })).toBe(false);
  });
});

describe('age bands (LA-STATS-02)', () => {
  // Judged in 2026: [birth year, band].
  it.each([
    [2026, 'UNDER_18'],
    [2009, 'UNDER_18'],
    [2008, 'AGE_18_TO_24'],
    [2002, 'AGE_18_TO_24'],
    [2001, 'AGE_25_TO_34'],
    [1992, 'AGE_25_TO_34'],
    [1991, 'AGE_35_TO_44'],
    [1982, 'AGE_35_TO_44'],
    [1981, 'AGE_45_TO_54'],
    [1972, 'AGE_45_TO_54'],
    [1971, 'AGE_55_AND_OVER'],
    [1927, 'AGE_55_AND_OVER'],
  ])('a listener born in %i is in %s', (birthYear, band) => {
    expect(ageBandOf(birthYear, 2026)).toBe(band);
  });

  it('names every band once, in order from the youngest', () => {
    expect([...LISTENER_AGE_BANDS]).toEqual(['UNDER_18', 'AGE_18_TO_24', 'AGE_25_TO_34', 'AGE_35_TO_44', 'AGE_45_TO_54', 'AGE_55_AND_OVER']);
  });
});
