import { createDecipheriv, createECDH, createPublicKey, type ECDH, hkdfSync, randomBytes, verify } from 'node:crypto';
import { isKnownPushServiceEndpoint } from '@lookup/contracts';
import { describe, expect, it, vi } from 'vitest';
import { encryptPushMessage, newVapidKeys, PushSendFailure, vapidAuthorization, vapidPublicKeyOf, WebPushSender } from '../src/features/notifications/web-push.js';

/** A browser's side of a subscription: its key pair and authentication secret. */
function newBrowser(): { keys: ECDH; device: { endpoint: string; receiverPublicKey: string; authenticationSecret: string } } {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  return {
    keys,
    device: { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('base64url')}`, receiverPublicKey: keys.getPublicKey().toString('base64url'), authenticationSecret: randomBytes(16).toString('base64url') },
  };
}

/** What the browser does with a message (RFC 8291 §3.4, RFC 8188 §2): written out here from the RFC's steps. */
function decryptAsTheBrowser(body: Buffer, receiver: ECDH, authenticationSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const keyIdLength = body.readUInt8(20);
  const senderPublicKey = body.subarray(21, 21 + keyIdLength);
  const record = body.subarray(21 + keyIdLength);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), receiver.getPublicKey(), senderPublicKey]);
  const inputKey = Buffer.from(hkdfSync('sha256', receiver.computeSecret(senderPublicKey), authenticationSecret, keyInfo, 32));
  const contentKey = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const decipher = createDecipheriv('aes-128-gcm', contentKey, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  return padded.subarray(0, padded.lastIndexOf(0x02));
}

const config = (keys = newVapidKeys()) => ({ WEB_PUSH_PUBLIC_KEY: keys.publicKey, WEB_PUSH_PRIVATE_KEY: keys.privateKey, WEB_PUSH_CONTACT_EMAIL: 'push@lookup.example' });
const notice = { title: 'Summer service offer airs soon', body: 'On Station A (98.1 FM) between 07:00 and 09:00 today. Listen in to check it.', url: '/client/stations/s/ads/a', tag: 'air-time-1' };

describe('web push', () => {
  it('P5C-NOTIFY-03: encrypts exactly as the worked example of RFC 8291 (Appendix A)', () => {
    const senderKeys = createECDH('prime256v1');
    senderKeys.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
    expect(senderKeys.getPublicKey().toString('base64url')).toBe('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    const body = encryptPushMessage(
      Buffer.from('When I grow up, I want to be a watermelon'),
      { receiverPublicKey: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', authenticationSecret: 'BTBZMqHH6r4Tts7J_aSIgg' },
      { senderKeys, salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url') },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
    // And the browser in the example reads it back.
    const receiver = createECDH('prime256v1');
    receiver.setPrivateKey(Buffer.from('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'base64url'));
    expect(decryptAsTheBrowser(body, receiver, Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url')).toString()).toBe('When I grow up, I want to be a watermelon');
  });

  it('P5C-NOTIFY-03: every message has its own sender key and salt, and is refused when too long or for a malformed key', () => {
    const browser = newBrowser();
    const first = encryptPushMessage(Buffer.from('same'), browser.device);
    const second = encryptPushMessage(Buffer.from('same'), browser.device);
    expect(first.subarray(0, 86).equals(second.subarray(0, 86))).toBe(false);
    expect(() => encryptPushMessage(Buffer.alloc(3001), browser.device)).toThrow('too long');
    expect(() => encryptPushMessage(Buffer.from('x'), { ...browser.device, receiverPublicKey: 'AAAA' })).toThrow('not an uncompressed P-256 public key');
    expect(() => encryptPushMessage(Buffer.from('x'), { ...browser.device, authenticationSecret: 'AAAA' })).toThrow('not 16 bytes');
  });

  it('P5C-ROLLOUT-01: a VAPID key pair is made of matching halves, and its signature verifies with the public half (RFC 8292)', () => {
    const keys = newVapidKeys();
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(vapidPublicKeyOf(keys.privateKey)).toBe(keys.publicKey);
    const now = Date.parse('2026-10-24T08:00:00Z');
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { ...keys, contactEmail: 'push@lookup.example' }, now);
    const [, token, publicKey] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
    expect(publicKey).toBe(keys.publicKey);
    const [encodedHeader, encodedClaims, signature] = (token as string).split('.');
    expect(JSON.parse(Buffer.from(encodedHeader as string, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(encodedClaims as string, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:push@lookup.example' });
    const raw = Buffer.from(keys.publicKey, 'base64url');
    const verifier = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
    expect(verify('sha256', Buffer.from(`${encodedHeader}.${encodedClaims}`), { key: verifier, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature as string, 'base64url'))).toBe(true);
  });

  it.each([
    ['https://fcm.googleapis.com/fcm/send/abc', true],
    ['https://updates.push.services.mozilla.com/wpush/v2/abc', true],
    ['https://web.push.apple.com/QGx', true],
    ['https://wns2-par02p.notify.windows.com/w/?token=abc', true],
    ['http://fcm.googleapis.com/fcm/send/abc', false],
    ['https://fcm.googleapis.com:8443/fcm/send/abc', false],
    ['https://user:secret@fcm.googleapis.com/fcm/send/abc', false],
    ['https://fcm.googleapis.com.attacker.example/abc', false],
    ['https://169.254.169.254/latest/meta-data', false],
    ['https://localhost/internal', false],
  ])('P5C-NOTIFY-03: %s is a browser push service: %s', (endpoint, isKnown) => {
    expect(isKnownPushServiceEndpoint(endpoint)).toBe(isKnown);
  });

  it('P5C-NOTIFY-03: the sender posts the notice encrypted, signed and with a lifetime, to the device’s push service only', async () => {
    const browser = newBrowser();
    const fetchFunction = vi.fn(async () => new Response(null, { status: 201 }));
    const sender = new WebPushSender(config(), fetchFunction as unknown as typeof fetch);
    expect(await sender.send(browser.device, notice, 900)).toBe('SENT');
    const [address, request] = fetchFunction.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(address).toBe(browser.device.endpoint);
    expect(request).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(request.headers).toMatchObject({ TTL: '900', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' });
    expect(request.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    const body = request.body as Buffer;
    expect(body.toString('latin1')).not.toContain('Summer service offer');
    expect(JSON.parse(decryptAsTheBrowser(body, browser.keys, Buffer.from(browser.device.authenticationSecret, 'base64url')).toString())).toEqual(notice);
  });

  it('P5C-NOTIFY-03: 404 and 410 mean the device is gone; another refusal names only its status; an unknown address is never posted to', async () => {
    const browser = newBrowser();
    for (const [status, outcome] of [[404, 'GONE'], [410, 'GONE']] as const) {
      const sender = new WebPushSender(config(), (async () => new Response(null, { status })) as unknown as typeof fetch);
      expect(await sender.send(browser.device, notice, 60)).toBe(outcome);
    }
    const refusing = new WebPushSender(config(), (async () => new Response('quota exceeded for this device', { status: 429 })) as unknown as typeof fetch);
    const failure = await refusing.send(browser.device, notice, 60).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(PushSendFailure);
    expect(failure).toMatchObject({ responseCode: 429, message: 'push service answered 429' });
    expect(String((failure as Error).message)).not.toContain(browser.device.endpoint);

    const fetchFunction = vi.fn();
    const careful = new WebPushSender(config(), fetchFunction as unknown as typeof fetch);
    expect(await careful.send({ ...browser.device, endpoint: 'https://169.254.169.254/latest/meta-data' }, notice, 60)).toBe('GONE');
    expect(fetchFunction).not.toHaveBeenCalled();
  });

  it('P5C-NOTIFY-06: without the keys there is no public key and nothing is sent', async () => {
    const sender = new WebPushSender({ WEB_PUSH_PUBLIC_KEY: undefined, WEB_PUSH_PRIVATE_KEY: undefined, WEB_PUSH_CONTACT_EMAIL: undefined });
    expect(sender.publicKey).toBeNull();
    await expect(sender.send(newBrowser().device, notice, 60)).rejects.toMatchObject({ name: 'PushSendFailure', responseCode: null });
  });
});
