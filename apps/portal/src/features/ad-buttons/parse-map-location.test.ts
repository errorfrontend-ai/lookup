import { describe, expect, it } from 'vitest';
import { parseMapLocation } from './parse-map-location';

const found = (latitude: number, longitude: number) => ({ kind: 'found', latitude, longitude });
const problem = (reason: string) => ({ kind: 'problem', problem: reason });

describe('reading a location for a Directions button', () => {
  describe('two numbers', () => {
    it.each([
      ['-15.4167, 28.2833', found(-15.4167, 28.2833)],
      ['-15.4167,28.2833', found(-15.4167, 28.2833)],
      ['  -15.4167   28.2833  ', found(-15.4167, 28.2833)],
      ['(-15.4167, 28.2833)', found(-15.4167, 28.2833)],
      ['-15.4167; 28.2833', found(-15.4167, 28.2833)],
      ['−15.4167, 28.2833', found(-15.4167, 28.2833)], // a typographic minus, as word processors make
      ['-15.4167°, 28.2833°', found(-15.4167, 28.2833)],
      ['15.4167° S, 28.2833° E', found(-15.4167, 28.2833)],
      ['15.4167S 28.2833E', found(-15.4167, 28.2833)],
      ['51.5072 N, 0.1276 W', found(51.5072, -0.1276)],
    ])('%s', (input, expected) => {
      expect(parseMapLocation(input)).toEqual(expected);
    });

    it('keeps six decimals and no more', () => {
      expect(parseMapLocation('-15.416712345678, 28.283312345678')).toEqual(found(-15.416712, 28.283312));
    });
  });

  describe('Google Maps links', () => {
    it.each([
      ['a place link: the pin, not the centre of the map', 'https://www.google.com/maps/place/Cairo+Road/@-15.4166,28.2833,17z/data=!3m1!4b1!4m6!3m5!1s0x1:0x2!8m2!3d-15.4167!4d28.2834!16s%2Fg%2F1', found(-15.4167, 28.2834)],
      ['a map centre', 'https://www.google.com/maps/@-15.4166,28.2833,15z', found(-15.4166, 28.2833)],
      ['a search with coordinates', 'https://www.google.com/maps?q=-15.4167,28.2833', found(-15.4167, 28.2833)],
      ['the link Look Up itself builds', 'https://www.google.com/maps/search/?api=1&query=-15.416700%2C28.283300', found(-15.4167, 28.2833)],
      ['a directions link', 'https://www.google.com/maps/dir/?api=1&destination=-15.4167,28.2833', found(-15.4167, 28.2833)],
      ['an old maps.google.com link', 'https://maps.google.com/?ll=-15.4167,28.2833&z=14', found(-15.4167, 28.2833)],
      ['a country address such as google.co.zm', 'https://www.google.co.zm/maps/@-15.4166,28.2833,15z', found(-15.4166, 28.2833)],
      ['a link pasted without https://', 'www.google.com/maps/@-15.4166,28.2833,15z', found(-15.4166, 28.2833)],
    ])('%s', (_name, link, expected) => {
      expect(parseMapLocation(link)).toEqual(expected);
    });

    it('prefers the pin over the centre when both are in the link', () => {
      const link = 'https://www.google.com/maps/place/X/@-1,2,17z/data=!8m2!3d-15.5!4d28.5';
      expect(parseMapLocation(link)).toEqual(found(-15.5, 28.5));
    });

    it('explains a short link: nothing is looked up on the internet, so it cannot be followed', () => {
      expect(parseMapLocation('https://maps.app.goo.gl/AbCdEf123')).toEqual(problem('short_link'));
      expect(parseMapLocation('https://goo.gl/maps/xyz')).toEqual(problem('short_link'));
      expect(parseMapLocation('maps.app.goo.gl/AbCdEf123')).toEqual(problem('short_link'));
    });

    it('does not guess from a link to somewhere else, or a Google link with no place in it', () => {
      expect(parseMapLocation('https://example.com/@-15.4,28.2')).toEqual(problem('unreadable'));
      expect(parseMapLocation('https://www.google.com/maps')).toEqual(problem('unreadable'));
      expect(parseMapLocation('https://www.google.com/maps/place/Cairo+Road')).toEqual(problem('unreadable'));
    });
  });

  describe('what is refused', () => {
    it('says when nothing was entered', () => {
      expect(parseMapLocation('')).toEqual(problem('empty'));
      expect(parseMapLocation('   ')).toEqual(problem('empty'));
    });

    it('accepts the edges of the earth and refuses anything just past them', () => {
      expect(parseMapLocation('90, 180')).toEqual(found(90, 180));
      expect(parseMapLocation('-90, -180')).toEqual(found(-90, -180));
      expect(parseMapLocation('90.5, 10')).toEqual(problem('out_of_range'));
      expect(parseMapLocation('-90.5, 10')).toEqual(problem('out_of_range'));
      expect(parseMapLocation('10, 180.5')).toEqual(problem('out_of_range'));
      expect(parseMapLocation('10, -180.5')).toEqual(problem('out_of_range'));
    });

    it('refuses numbers outside the earth, rather than swapping them round', () => {
      expect(parseMapLocation('95, 10')).toEqual(problem('out_of_range'));
      expect(parseMapLocation('28.2833, -195.4167')).toEqual(problem('out_of_range'));
      expect(parseMapLocation('28.2833, 195.4167')).toEqual(problem('out_of_range'));
    });

    it('refuses 0, 0: it is where a missing location lands, in the sea off Africa', () => {
      expect(parseMapLocation('0, 0')).toEqual(problem('zero_zero'));
      expect(parseMapLocation('0.0000000001, 0')).toEqual(problem('zero_zero'));
    });

    it.each(['Cairo Road, Lusaka', 'abc', '-15.4167', '-15.4167, 28.2833, 12', 'javascript:alert(1)', 'tel:+260977123456'])('does not read %s', (input) => {
      expect(parseMapLocation(input)).toEqual(problem('unreadable'));
    });
  });
});
