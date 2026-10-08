import { describe, expect, it } from 'vitest';
import { isCanonicalHttpsLink } from '../src/action-card/action-card-reader.js';
import { readFixtureFile } from './fixtures.js';

/**
 * S4-D17: the listener app has no WHATWG URL parser, so it writes the "already canonical" check out
 * rule by rule. These cases hold one link per rule and per character, with the answer the real
 * `isCanonicalHttpsLink` gives and what Node's own parser makes of the link (`parsed_href`, null
 * when it refuses it), so the app's check is held to Node's behaviour, not to a guess at it.
 */
interface CanonicalLinkCase {
  description: string;
  link: string;
  is_canonical: boolean;
  parsed_href: string | null;
}

function parsedHref(link: string): string | null {
  try {
    return new URL(link).href;
  } catch {
    return null;
  }
}

describe('canonical https links (the cases the listener app checks its own rule against)', () => {
  const linkCases = readFixtureFile<CanonicalLinkCase[]>('action-card/canonical-links.json');

  it.each(linkCases.map((linkCase) => [linkCase.description, linkCase] as const))('%s', (_description, linkCase) => {
    expect(isCanonicalHttpsLink(linkCase.link)).toBe(linkCase.is_canonical);
  });

  it.each(linkCases.map((linkCase) => [linkCase.link, linkCase] as const))('Node parses %s as the fixture says', (_link, linkCase) => {
    expect(parsedHref(linkCase.link)).toBe(linkCase.parsed_href);
  });

  it('a link the parser would rewrite or refuse is never canonical', () => {
    for (const linkCase of linkCases.filter((candidate) => candidate.is_canonical)) {
      expect(parsedHref(linkCase.link), linkCase.description).toBe(linkCase.link);
    }
  });

  it('has a case for every rule and character the app writes out, with both answers', () => {
    const links = linkCases.map((linkCase) => linkCase.link);
    const backslash = String.fromCharCode(92);
    const pathOf = (link: string) => link.replace(/^[A-Za-z]+:\/\/[^/?#]*/, '').split(/[?#]/)[0] ?? '';
    const queryOf = (link: string) => (link.includes('?') ? link.slice(link.indexOf('?') + 1).split('#')[0] ?? '' : '');
    const fragmentOf = (link: string) => (link.includes('#') ? link.slice(link.indexOf('#') + 1) : '');
    for (const character of ['"', '<', '>', '`', '{', '}', '^', "'", backslash]) {
      expect(links.some((link) => pathOf(link).includes(character)), `path ${character}`).toBe(true);
    }
    for (const character of ['"', '<', '>', "'", '`', '{', '}', '^', backslash]) {
      expect(links.some((link) => queryOf(link).includes(character)), `query ${character}`).toBe(true);
    }
    for (const character of ['"', '<', '>', '`', "'", '{', '}', '^', backslash]) {
      expect(links.some((link) => fragmentOf(link).includes(character)), `fragment ${character}`).toBe(true);
    }
    for (const part of ['/./', '/../', '%2e', '%2E', '@', ':443', ':8443', 'http:', 'HTTPS:', 'xn--', 'XN--']) {
      expect(links.some((link) => link.includes(part)), part).toBe(true);
    }
    expect(linkCases.filter((linkCase) => linkCase.is_canonical).length).toBeGreaterThanOrEqual(15);
    expect(linkCases.filter((linkCase) => !linkCase.is_canonical).length).toBeGreaterThanOrEqual(30);
  });
});
