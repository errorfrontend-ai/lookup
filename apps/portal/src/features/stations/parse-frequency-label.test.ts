import { describe, expect, it } from 'vitest';
import { parseFrequencyLabel } from './parse-frequency-label';

describe('parseFrequencyLabel', () => {
  it.each([
    ['98.1 FM', { band: 'FM', numberText: '98.1', value: 98.1 }],
    ['89.5 fm', { band: 'FM', numberText: '89.5', value: 89.5 }],
    ['  104 FM  ', { band: 'FM', numberText: '104', value: 104 }],
    ['1260 AM', { band: 'AM', numberText: '1260', value: 1260 }],
  ])('reads %s', (label, expected) => {
    expect(parseFrequencyLabel(label)).toEqual(expected);
  });

  it.each(['', 'Radio One', '98.1', '98.1 MHz', 'FM 98.1', '200 FM', '50 FM', '98.123 FM'])('gives up on %j, so the label is shown as written', (label) => {
    expect(parseFrequencyLabel(label)).toBeNull();
  });
});
