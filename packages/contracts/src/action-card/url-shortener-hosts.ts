/**
 * Link shorteners hide where a button really leads, which is how scam links get past a quick look.
 * Stations must link to the real destination. Hosts are matched exactly or as a parent domain
 * (so "www.bit.ly" is refused too). Extend this list when new shorteners show up in reports.
 */
export const URL_SHORTENER_HOSTS: readonly string[] = [
  'adf.ly',
  'bit.ly',
  'bitly.com',
  'bl.ink',
  'buff.ly',
  'cutt.ly',
  'goo.gl',
  'is.gd',
  'lnkd.in',
  'ow.ly',
  'qr.ae',
  'rb.gy',
  'rebrand.ly',
  's.id',
  'shorte.st',
  'shorturl.at',
  't.co',
  't.ly',
  'tiny.cc',
  'tinyurl.com',
  'trib.al',
  'v.gd',
];

export function isUrlShortenerHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
  return URL_SHORTENER_HOSTS.some(
    (shortenerHost) => normalizedHostname === shortenerHost || normalizedHostname.endsWith(`.${shortenerHost}`),
  );
}
