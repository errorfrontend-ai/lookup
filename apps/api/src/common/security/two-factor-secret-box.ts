import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Seals a super admin's second-factor secret for the database (P5A design §5.4, P5A-D19): AES-256-GCM under a key
 * derived from TWO_FACTOR_ENCRYPTION_SECRET alone, with the user's id as associated data, so a sealed secret copied
 * onto another account does not open. Stored as nonce ‖ ciphertext ‖ tag.
 */
export class TwoFactorSecretBox {
  private readonly key: Buffer;

  constructor(encryptionSecret: string) {
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(encryptionSecret, 'base64url'), Buffer.alloc(0), 'lookup two-factor secrets v1', 32));
  }

  seal(portalUserId: string, secret: Uint8Array): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(portalUserId, 'utf8'));
    return Buffer.concat([nonce, cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
  }

  /** The secret, or null when the box does not open: another account's, changed, or sealed under another key. */
  open(portalUserId: string, sealed: Uint8Array): Uint8Array | null {
    if (sealed.length <= NONCE_BYTES + TAG_BYTES) return null;
    const bytes = Buffer.from(sealed);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(portalUserId, 'utf8'));
      decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
      return new Uint8Array(Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]));
    } catch {
      return null;
    }
  }
}
