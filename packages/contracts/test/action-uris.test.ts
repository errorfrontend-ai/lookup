import { describe, expect, it } from 'vitest';
import type { ReadAction } from '../src/action-card/action-card-reader.js';
import { buildActionUri, buildMapSearchAddress } from '../src/action-card/action-uris.js';

const whatsApp = (prefilledText: string): ReadAction =>
  ({ type: 'WHATSAPP', id: '0192a6c4-0000-4000-8000-000000000002', label: 'WhatsApp us', style: 'SECONDARY', phoneNumberE164: '+260966123456', prefilledText }) as ReadAction;

describe('button addresses beyond the shared fixtures', () => {
  it('a WhatsApp text that cannot be encoded (a lone surrogate) gives no address rather than an error', () => {
    expect(() => buildActionUri(whatsApp('Hi \ud800 there'))).not.toThrow();
    expect(buildActionUri(whatsApp('Hi \ud800 there'))).toBeNull();
    expect(buildActionUri(whatsApp('Hi there'))).toBe('https://wa.me/260966123456?text=Hi%20there');
  });

  it('the portal’s pin check shows the place itself, with the same six decimals as the directions a listener gets', () => {
    expect(buildMapSearchAddress(-15.4167, 28.2833)).toBe('https://www.google.com/maps/search/?api=1&query=-15.416700%2C28.283300');
    expect(buildMapSearchAddress(-0, 28)).toBe('https://www.google.com/maps/search/?api=1&query=0.000000%2C28.000000');
    for (const [latitude, longitude] of [[91, 28], [-15, 181], [Number.NaN, 28], [-15, Number.POSITIVE_INFINITY]]) {
      expect(buildMapSearchAddress(latitude as number, longitude as number)).toBeNull();
    }
  });
});
