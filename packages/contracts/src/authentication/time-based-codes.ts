/**
 * The super admin's second factor (P5A design §5.4): time-based one-time codes as RFC 6238 defines them, as every
 * authenticator app computes them — HMAC-SHA-1, 6 digits, a 30-second step counted from the Unix epoch — and one
 * step either side accepted, for a phone clock a little off. Each step is accepted once; the API keeps the last used.
 *
 * Shared by the API (checking a code), the enrolment command (printing the address) and the browser tests (computing
 * the code from the seeded secret). It uses Web Crypto, which Node and every browser provide, so it adds nothing to
 * either.
 */

export const TWO_FACTOR_CODE_DIGITS = 6;
export const TWO_FACTOR_TIME_STEP_SECONDS = 30;
/** Steps either side of the current one that still count (RFC 6238 §5.2 recommends at most one). */
export const TWO_FACTOR_ALLOWED_DRIFT_STEPS = 1;
/** A new secret's length: 160 bits, the size of HMAC-SHA-1's output (RFC 4226 §4 asks for at least 128). */
export const TWO_FACTOR_SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The step a moment falls in. */
export function twoFactorTimeStepAt(unixMilliseconds: number): number {
  return Math.floor(unixMilliseconds / 1000 / TWO_FACTOR_TIME_STEP_SECONDS);
}

/** The code for one step (RFC 4226 §5.3's dynamic truncation, then the last six digits). */
export async function computeTwoFactorCode(secret: Uint8Array, timeStep: number): Promise<string> {
  if (!Number.isSafeInteger(timeStep) || timeStep < 0) throw new RangeError('the time step must be a whole number from 0');
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(timeStep));
  const key = await globalThis.crypto.subtle.importKey('raw', new Uint8Array(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const digest = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, counter));
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    ((digest[offset + 1] as number) << 16) |
    ((digest[offset + 2] as number) << 8) |
    (digest[offset + 3] as number);
  return String(binary % 10 ** TWO_FACTOR_CODE_DIGITS).padStart(TWO_FACTOR_CODE_DIGITS, '0');
}

/**
 * The step a typed code belongs to — the current one, or one either side — or null when it is none of them. Every
 * step is computed and compared, so the time taken does not say which step matched.
 */
export async function findTwoFactorTimeStep(secret: Uint8Array, typedCode: string, unixMilliseconds: number): Promise<number | null> {
  if (!/^[0-9]{6}$/.test(typedCode)) return null;
  const current = twoFactorTimeStepAt(unixMilliseconds);
  let matched: number | null = null;
  for (let drift = -TWO_FACTOR_ALLOWED_DRIFT_STEPS; drift <= TWO_FACTOR_ALLOWED_DRIFT_STEPS; drift += 1) {
    const step = current + drift;
    if (step < 0) continue;
    const isSame = isSameCode(await computeTwoFactorCode(secret, step), typedCode);
    if (isSame && matched === null) matched = step;
  }
  return matched;
}

/** Both are six digits (checked above); every digit is compared, wherever they first differ. */
function isSameCode(expected: string, typed: string): boolean {
  let difference = 0;
  for (let index = 0; index < TWO_FACTOR_CODE_DIGITS; index += 1) difference |= expected.charCodeAt(index) ^ typed.charCodeAt(index);
  return difference === 0;
}

/** RFC 4648 base32 without padding, as authenticator apps take a secret. */
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let text = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) text += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return text;
}

/** The bytes of a base32 secret (letters in either case, spaces and padding ignored), or null when it is not one. */
export function decodeBase32(text: string): Uint8Array | null {
  const cleaned = text.replace(/[\s=]/g, '').toUpperCase();
  if (cleaned.length === 0 || /[^A-Z2-7]/.test(cleaned)) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of cleaned) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** The address an authenticator app reads from a QR code or a link (Google's "Key Uri Format"). */
export function twoFactorEnrolmentAddress(accountEmail: string, secret: Uint8Array): string {
  const label = `${encodeURIComponent('Look Up')}:${encodeURIComponent(accountEmail)}`;
  return `otpauth://totp/${label}?secret=${encodeBase32(secret)}&issuer=${encodeURIComponent('Look Up')}&algorithm=SHA1&digits=6&period=30`;
}
