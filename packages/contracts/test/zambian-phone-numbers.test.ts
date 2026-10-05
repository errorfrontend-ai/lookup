import { describe, expect, it } from 'vitest';
import { formatPhoneNumberForDisplay, normalizeZambianPhoneInput } from '../src/phone-numbers/zambian-phone-numbers.js';
import { readFixtureFile } from './fixtures.js';

describe('phone numbers as stations type them', () => {
  const fixtures = readFixtureFile<Array<{ input: string; expected: string | null }>>(
    'phone-numbers/zambian-input-normalization.json',
  );

  it.each(fixtures.map((fixture) => [fixture.input, fixture.expected] as const))('"%s" becomes %s', (input, expected) => {
    expect(normalizeZambianPhoneInput(input)).toBe(expected);
  });

  it('shows Zambian numbers grouped for the station to confirm, and others as stored', () => {
    expect(formatPhoneNumberForDisplay('+260977123456')).toBe('+260 97 712 3456');
    expect(formatPhoneNumberForDisplay('+27821234567')).toBe('+27821234567');
  });
});
