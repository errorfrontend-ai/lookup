import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Keeps a listener's email (ADR-005, design LA-D11): the platform needs the address only to send the sign-in code to
 * whoever types it, but keeps it sealed so it can be read back if it ever must be.
 *
 *  - `hash` is a keyed HMAC-SHA-256 of the lower-cased address: how an account is found and made unique. Without the
 *    key it cannot be matched to an address by hashing guesses.
 *  - `seal` and `open` are AES-256-GCM with the account's id as associated data, so a sealed email copied onto
 *    another account does not open. Stored as nonce ‖ ciphertext ‖ tag.
 *
 * Both keys come from LISTENER_EMAIL_ENCRYPTION_SECRET alone (not AUTHENTICATION_SECRET): rotating the sign-in
 * secrets must never orphan the accounts.
 */
export class ListenerEmailBox {
  private readonly hashingKey: Buffer;
  private readonly sealingKey: Buffer;

  constructor(encryptionSecret: string) {
    const secret = Buffer.from(encryptionSecret, 'base64url');
    this.hashingKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'lookup listener email hash v1', 32));
    this.sealingKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'lookup listener email seal v1', 32));
  }

  /** The 32-byte lookup hash of an address already trimmed and lower-cased by the contract's schema. */
  hash(email: string): Buffer {
    return createHmac('sha256', this.hashingKey).update(email).digest();
  }

  seal(listenerAccountId: string, email: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.sealingKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(listenerAccountId, 'utf8'));
    return Buffer.concat([nonce, cipher.update(email, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  }

  /** The address, or null when the box does not open: another account's, changed, or sealed under another key. */
  open(listenerAccountId: string, sealed: Uint8Array): string | null {
    if (sealed.length <= NONCE_BYTES + TAG_BYTES) return null;
    const bytes = Buffer.from(sealed);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.sealingKey, bytes.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(listenerAccountId, 'utf8'));
      decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
      return Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

/**
 * The address as Settings shows it: the first character, stars, and the domain ("a***@gmail.com"). Enough for a
 * listener to see which address they used, too little to be an address.
 */
export function maskEmailAddress(email: string): string {
  const atSign = email.lastIndexOf('@');
  if (atSign < 1) return '***';
  return `${email.slice(0, 1)}***${email.slice(atSign)}`;
}
