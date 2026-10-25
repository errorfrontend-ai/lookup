import { createCipheriv, createECDH, createPrivateKey, type ECDH, hkdfSync, randomBytes, sign } from 'node:crypto';
import { isKnownPushServiceEndpoint } from '@lookup/contracts';
import type { AppConfig } from '../../config/app-config.js';

/**
 * Web Push from Node's own crypto (ADR-006 decision 7): the message encrypted for one browser (RFC 8291, "aes128gcm" of
 * RFC 8188) and the server's VAPID signature (RFC 8292). No push library: both are short, fully specified, and the tests
 * check the encryption against the RFC's own worked example.
 */

/** One record holds the whole message: push services accept at most 4096 bytes. */
const RECORD_SIZE = 4096;
/** What a notice may take up once encoded, leaving room for the record's header, delimiter and tag. */
export const MAXIMUM_PUSH_PAYLOAD_BYTES = 3000;
/** A VAPID signature is good for at most 24 hours (RFC 8292 §2); 12 leaves room for clock differences. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;
const PUSH_REQUEST_TIMEOUT_MILLISECONDS = 10_000;

/** A browser's push subscription, as stored: where to send, and its keys (base64url). */
export interface PushDevice {
  endpoint: string;
  receiverPublicKey: string;
  authenticationSecret: string;
}

/** What the service worker shows: a title, a line, the page a tap opens, and a tag so a newer notice replaces an older one. */
export interface PushNotice {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  contactEmail: string;
}

/**
 * The message encrypted for one browser (RFC 8291 §3, RFC 8188 §2): a fresh sender key pair and salt for every message,
 * one record, the last-record delimiter 0x02 and no padding. [fixed] supplies the key pair and salt only for the
 * RFC's worked example.
 */
export function encryptPushMessage(plaintext: Buffer, device: Pick<PushDevice, 'receiverPublicKey' | 'authenticationSecret'>, fixed: { senderKeys?: ECDH; salt?: Buffer } = {}): Buffer {
  const receiverPublicKey = Buffer.from(device.receiverPublicKey, 'base64url');
  const authenticationSecret = Buffer.from(device.authenticationSecret, 'base64url');
  if (receiverPublicKey.length !== 65 || receiverPublicKey[0] !== 0x04) throw new Error('the receiver key is not an uncompressed P-256 public key');
  if (authenticationSecret.length !== 16) throw new Error('the authentication secret is not 16 bytes');
  if (plaintext.length > MAXIMUM_PUSH_PAYLOAD_BYTES) throw new Error('the push message is too long');

  const senderKeys = fixed.senderKeys ?? newSenderKeys();
  const senderPublicKey = senderKeys.getPublicKey();
  const sharedSecret = senderKeys.computeSecret(receiverPublicKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), receiverPublicKey, senderPublicKey]);
  const inputKey = Buffer.from(hkdfSync('sha256', sharedSecret, authenticationSecret, keyInfo, 32));
  const salt = fixed.salt ?? randomBytes(16);
  const contentKey = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));

  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublicKey.length, 20);
  return Buffer.concat([header, senderPublicKey, record]);
}

function newSenderKeys(): ECDH {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  return keys;
}

/** The public key (65 bytes, base64url) that belongs to a VAPID private key (32 bytes, base64url). */
export function vapidPublicKeyOf(privateKey: string): string {
  const keys = createECDH('prime256v1');
  keys.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  return keys.getPublicKey().toString('base64url');
}

/** A new VAPID key pair, for `npm run deploy:new-secrets -- WEB_PUSH_KEYS`. */
export function newVapidKeys(): { publicKey: string; privateKey: string } {
  const keys = newSenderKeys();
  return { publicKey: keys.getPublicKey().toString('base64url'), privateKey: keys.getPrivateKey().toString('base64url') };
}

/** The Authorization header that proves the message comes from this server (RFC 8292 §2–3): "vapid t=<JWT>, k=<public key>". */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowMilliseconds = Date.now()): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ typ: 'JWT', alg: 'ES256' });
  const claims = encode({ aud: new URL(endpoint).origin, exp: Math.floor(nowMilliseconds / 1000) + VAPID_LIFETIME_SECONDS, sub: `mailto:${keys.contactEmail}` });
  const publicKey = Buffer.from(keys.publicKey, 'base64url');
  const privateKey = createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: publicKey.subarray(1, 33).toString('base64url'), y: publicKey.subarray(33, 65).toString('base64url') },
  });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

/**
 * A push service refused a message for a reason other than "this device is gone". Only the status is kept: the
 * service's own answer and the device's address are never logged.
 */
export class PushSendFailure extends Error {
  constructor(readonly responseCode: number | null) {
    super(responseCode === null ? 'push not configured' : `push service answered ${responseCode}`);
    this.name = 'PushSendFailure';
  }
}

/** SENT, or GONE when the push service no longer knows the device (404, 410), which is then forgotten. */
export type PushOutcome = 'SENT' | 'GONE';

export interface PushSender {
  /** The server's VAPID public key for a browser's subscription, or null when push is not configured. */
  readonly publicKey: string | null;
  send(device: PushDevice, notice: PushNotice, ttlSeconds: number): Promise<PushOutcome>;
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/**
 * Sends one encrypted notice to one browser's push service. Only the browsers' own push services are ever posted to
 * (isKnownPushServiceEndpoint): a device stored with any other address is treated as gone, so a client cannot make the
 * server post somewhere else. Redirects are refused for the same reason.
 */
export class WebPushSender implements PushSender {
  private readonly keys: VapidKeys | null;

  constructor(
    config: Pick<AppConfig, 'WEB_PUSH_PUBLIC_KEY' | 'WEB_PUSH_PRIVATE_KEY' | 'WEB_PUSH_CONTACT_EMAIL'>,
    private readonly fetchFunction: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.keys =
      config.WEB_PUSH_PUBLIC_KEY && config.WEB_PUSH_PRIVATE_KEY && config.WEB_PUSH_CONTACT_EMAIL
        ? { publicKey: config.WEB_PUSH_PUBLIC_KEY, privateKey: config.WEB_PUSH_PRIVATE_KEY, contactEmail: config.WEB_PUSH_CONTACT_EMAIL }
        : null;
  }

  get publicKey(): string | null {
    return this.keys?.publicKey ?? null;
  }

  async send(device: PushDevice, notice: PushNotice, ttlSeconds: number): Promise<PushOutcome> {
    if (!this.keys) throw new PushSendFailure(null);
    if (!isKnownPushServiceEndpoint(device.endpoint)) return 'GONE';
    const response = await this.fetchFunction(device.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(Math.max(0, Math.round(ttlSeconds))),
        Urgency: 'high',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: vapidAuthorization(device.endpoint, this.keys),
      },
      body: encryptPushMessage(Buffer.from(JSON.stringify(notice)), device),
      redirect: 'error',
      signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MILLISECONDS),
    });
    if (response.ok) return 'SENT';
    if (response.status === 404 || response.status === 410) return 'GONE';
    throw new PushSendFailure(response.status);
  }
}
