import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TwoFactorSecretBox } from '../src/common/security/two-factor-secret-box.js';

/** P5A design §5.4, P5A-D19: the sealed second-factor secret opens only for its own account, unchanged, under its own key. */
describe('the two-factor secret box', () => {
  const box = new TwoFactorSecretBox(randomBytes(32).toString('base64url'));
  const userId = randomUUID();
  const secret = randomBytes(20);

  it('seals a secret that opens again for the same account, never stored in the clear, different each time', () => {
    const sealed = box.seal(userId, secret);
    expect(sealed.length).toBe(12 + secret.length + 16);
    expect(sealed.includes(secret)).toBe(false);
    expect(Buffer.from(box.open(userId, sealed) ?? [])).toEqual(secret);
    expect(box.seal(userId, secret).equals(sealed)).toBe(false);
  });

  it('does not open for another account, after any change, under another key, or when too short', () => {
    const sealed = box.seal(userId, secret);
    expect(box.open(randomUUID(), sealed)).toBeNull();
    for (const position of [0, 12, sealed.length - 1]) {
      const changed = Buffer.from(sealed);
      changed[position] = (changed[position] as number) ^ 1;
      expect(box.open(userId, changed), `byte ${position}`).toBeNull();
    }
    expect(new TwoFactorSecretBox(randomBytes(32).toString('base64url')).open(userId, sealed)).toBeNull();
    expect(box.open(userId, sealed.subarray(0, 28))).toBeNull();
  });
});
