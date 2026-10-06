import { ActionCard } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { readWebAddress } from './read-web-address';

const found = (url: string) => ({ kind: 'found', url });
const problem = (reason: string) => ({ kind: 'problem', problem: reason });

describe('reading a web address for a button', () => {
  it.each([
    ['https://brand.co.zm/offer', 'https://brand.co.zm/offer'],
    ['brand.co.zm/offer', 'https://brand.co.zm/offer'],
    ['  www.brand.co.zm  ', 'https://www.brand.co.zm/'],
    ['brand.co.zm', 'https://brand.co.zm/'],
    ['HTTPS://Brand.CO.ZM/Offer?utm_source=radio', 'https://brand.co.zm/Offer?utm_source=radio'],
    ['https://brand.co.zm/a b'.replace(' ', '%20'), 'https://brand.co.zm/a%20b'],
    ['https://brand.co.zm:443/', 'https://brand.co.zm/'],
  ])('%s becomes %s', (input, expected) => {
    expect(readWebAddress(input)).toEqual(found(expected));
  });

  it('writes an international domain in plain letters, so a lookalike shows for what it is', () => {
    expect(readWebAddress('https://bücher.co.zm/')).toEqual(found('https://xn--bcher-kva.co.zm/'));
  });

  it('only ever gives an address the card itself accepts', () => {
    for (const input of ['brand.co.zm', 'https://brand.co.zm/offer?x=1#top', 'bücher.co.zm', 'https://sub.brand.co.zm/a/b/c']) {
      const reading = readWebAddress(input);
      expect(reading.kind).toBe('found');
      if (reading.kind !== 'found') continue;
      const card = { schema_version: 1, layout: 'VERTICAL_STACK', actions: [{ type: 'LINK', id: '0190f1a2-0000-7000-8000-0000000000e1', label: 'Visit', style: 'PRIMARY', url: reading.url }] };
      expect(ActionCard.safeParse(card).success, input).toBe(true);
    }
  });

  it('refuses an address that is not secure, and says so', () => {
    expect(readWebAddress('http://brand.co.zm')).toEqual(problem('not_secure'));
    expect(readWebAddress('HTTP://brand.co.zm')).toEqual(problem('not_secure'));
  });

  it('refuses things that are not web pages', () => {
    for (const input of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hi', 'mailto:someone@brand.co.zm', 'tel:+260977123456', 'ftp://brand.co.zm/file', 'file:///etc/passwd']) {
      expect(readWebAddress(input), input).toEqual(problem('not_a_web_address'));
    }
  });

  it('refuses an address with a login in it, which hides the real host', () => {
    expect(readWebAddress('https://brand.co.zm@evil.example/')).toEqual(problem('has_login'));
    expect(readWebAddress('https://user:secret@brand.co.zm/')).toEqual(problem('has_login'));
  });

  it('refuses link shorteners, and the same shorteners with a subdomain', () => {
    expect(readWebAddress('https://bit.ly/3abc')).toEqual(problem('shortener'));
    expect(readWebAddress('tinyurl.com/yabc')).toEqual(problem('shortener'));
    expect(readWebAddress('https://www.bit.ly/3abc')).toEqual(problem('shortener'));
  });

  it('refuses what is not a real domain: no dot, a number address, a port, spaces', () => {
    for (const input of ['localhost', 'brand', 'https://192.168.1.10/', 'https://[::1]/', 'https://brand.co.zm:8443/', 'brand co zm', 'https://']) {
      expect(readWebAddress(input), input).toEqual(problem('unreadable'));
    }
  });

  it('refuses an address with a space in it, rather than quietly making a broken link out of a pasted sentence', () => {
    for (const input of ['https://brand.co.zm/offer thanks', 'https://brand.co.zm/my offer', 'brand.co.zm/offer see you there', 'https://brand.co.zm/offer	now']) {
      expect(readWebAddress(input), input).toEqual(problem('unreadable'));
    }
  });

  it('says when nothing was entered, and when the address is longer than the card allows', () => {
    expect(readWebAddress('')).toEqual(problem('empty'));
    expect(readWebAddress('   ')).toEqual(problem('empty'));
    expect(readWebAddress(`https://brand.co.zm/${'a'.repeat(2100)}`)).toEqual(problem('too_long'));
  });
});
