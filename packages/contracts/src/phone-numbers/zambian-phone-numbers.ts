/**
 * Turns what a station types into the E.164 form the card stores, with Zambia (+260) as the home
 * country: "0977 123 456", "097-712-3456", "+260 977 123 456", "260977123456", "00260977123456" and
 * "977123456" all become "+260977123456"; a foreign number written with its "+" or "00" is kept.
 * Returns null for anything else, and the portal asks for the number again.
 *
 * Only the length is checked (9 digits after +260), not operator prefixes: ZICTA added new mobile
 * ranges in 2024, so a prefix list would go out of date.
 */
const SEPARATORS = /[\s\-.()]/g;
const PHONE_NUMBER_E164 = /^\+[1-9][0-9]{6,14}$/;
const ZAMBIAN_PHONE_NUMBER_E164 = /^\+260[1-9][0-9]{8}$/;

export function normalizeZambianPhoneInput(input: string): string | null {
  const compact = input.trim().replace(SEPARATORS, '');
  let candidate: string;
  if (/^\+[0-9]+$/.test(compact)) candidate = compact;
  else if (/^00[0-9]+$/.test(compact)) candidate = `+${compact.slice(2)}`;
  else if (/^260[0-9]{9}$/.test(compact)) candidate = `+${compact}`;
  else if (/^0[1-9][0-9]{8}$/.test(compact)) candidate = `+260${compact.slice(1)}`;
  else if (/^[1-9][0-9]{8}$/.test(compact)) candidate = `+260${compact}`;
  else return null;

  if (!PHONE_NUMBER_E164.test(candidate)) return null;
  if (candidate.startsWith('+260') && !ZAMBIAN_PHONE_NUMBER_E164.test(candidate)) return null;
  return candidate;
}

/** "+260977123456" → "+260 97 712 3456" for the station to confirm; other countries are shown as stored. */
export function formatPhoneNumberForDisplay(phoneNumberE164: string): string {
  const zambianMatch = /^\+260([0-9]{2})([0-9]{3})([0-9]{4})$/.exec(phoneNumberE164);
  return zambianMatch ? `+260 ${zambianMatch[1]} ${zambianMatch[2]} ${zambianMatch[3]}` : phoneNumberE164;
}
