import { isUrlShortenerHost, MAXIMUM_LINK_URL_LENGTH } from '@lookup/contracts';

export type WebAddressProblem = 'empty' | 'not_secure' | 'not_a_web_address' | 'unreadable' | 'has_login' | 'shortener' | 'too_long';

export type WebAddressReading = { kind: 'found'; url: string } | { kind: 'problem'; problem: WebAddressProblem };

const REAL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const OTHER_KINDS_OF_ADDRESS = /^(javascript|data|vbscript|mailto|tel|sms|file|blob|about):/i;

/**
 * Turns what a station types into the one canonical https address the card stores: "brand.co.zm/offer"
 * becomes "https://brand.co.zm/offer", an international domain becomes its plain-letters form (so a
 * lookalike is visible), and anything the card refuses is named: "http://" (not secure), a login in
 * the address, a link shortener (it hides where the button goes), an address with no real domain.
 * The listener app follows the same card rules, so a link that passes here is one it will open.
 */
export function readWebAddress(input: string): WebAddressReading {
  const text = input.trim();
  if (text === '') return { kind: 'problem', problem: 'empty' };
  if (/\s/.test(text)) return { kind: 'problem', problem: 'unreadable' };
  if (OTHER_KINDS_OF_ADDRESS.test(text)) return { kind: 'problem', problem: 'not_a_web_address' };
  if (/^http:\/\//i.test(text)) return { kind: 'problem', problem: 'not_secure' };
  if (REAL_SCHEME.test(text) && !/^https:\/\//i.test(text)) return { kind: 'problem', problem: 'not_a_web_address' };

  let url: URL;
  try {
    url = new URL(/^https:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { kind: 'problem', problem: 'unreadable' };
  }
  if (url.username !== '' || url.password !== '') return { kind: 'problem', problem: 'has_login' };
  // A real domain: dotted, ending in a name (not a number, so no IP addresses), and no port.
  if (!/\.[a-z][a-z0-9-]*$/i.test(url.hostname) || url.port !== '') return { kind: 'problem', problem: 'unreadable' };
  if (isUrlShortenerHost(url.hostname)) return { kind: 'problem', problem: 'shortener' };
  if (url.href.length > MAXIMUM_LINK_URL_LENGTH) return { kind: 'problem', problem: 'too_long' };
  return { kind: 'found', url: url.href };
}
