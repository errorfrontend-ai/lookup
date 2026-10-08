import { describe, expect, it } from 'vitest';
import { referenceCodeForRequestId } from '../src/errors/reference-code.js';
import { readFixtureFile } from './fixtures.js';

/** S4-D9: the listener app, the API's tests and any support tool read these same cases. */
interface ReferenceCodeCase {
  description: string;
  request_id: string;
  reference_code: string | null;
}

describe('reference codes (what a listener reads out to support)', () => {
  const codeCases = readFixtureFile<ReferenceCodeCase[]>('errors/reference-codes.json');

  it.each(codeCases.map((codeCase) => [codeCase.description, codeCase] as const))('%s', (_description, codeCase) => {
    expect(referenceCodeForRequestId(codeCase.request_id)).toBe(codeCase.reference_code);
  });

  it('a code finds its request: the id starts with the code once the dash is taken out and it is lower-cased', () => {
    for (const { request_id: requestId, reference_code: referenceCode } of codeCases) {
      if (referenceCode === null) continue;
      expect(referenceCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
      expect(requestId.toLowerCase().startsWith(referenceCode.replace('-', '').toLowerCase())).toBe(true);
    }
  });

  it('has ids that give a code and ids that give none', () => {
    expect(codeCases.filter((codeCase) => codeCase.reference_code !== null).length).toBeGreaterThanOrEqual(5);
    expect(codeCases.filter((codeCase) => codeCase.reference_code === null).length).toBeGreaterThanOrEqual(8);
  });
});
