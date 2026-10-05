/**
 * Removes what could identify a person or unlock an account from text that may quote input (error
 * messages and stack traces, from clients or from our own database errors): email addresses,
 * phone-number-like digit runs, long token-like strings (password hashes, session tokens), and URL
 * query strings and fragments.
 */
export function scrubPersonalData(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '[number]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[token]')
    .replace(/(https?:\/\/[^\s?#]*)[?#][^\s]*/g, '$1');
}

/** A location reduced to its path: no query string, no fragment. */
export function pathOnly(location: string): string {
  return location.split(/[?#]/)[0] ?? '';
}
