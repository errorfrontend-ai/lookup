import { randomBytes } from 'node:crypto';

/**
 * UUID version 7 (RFC 9562): a 48-bit Unix time in milliseconds, then random bits, so ids sort in the
 * order they were made, which keeps the busiest tables' indexes compact (conventions: UUIDv7 for
 * high-volume ids). Ids made in the same millisecond stay in order: the 12 bits after the version
 * count up from a random start (RFC 9562 §6.2, method 1); if they run out, the time moves on by one.
 */
let lastMilliseconds = -1;
let counter = 0;

export function uuidVersion7(now: () => number = Date.now): string {
  let milliseconds = now();
  if (milliseconds <= lastMilliseconds) {
    counter += 1;
    if (counter > 0xfff) {
      lastMilliseconds += 1;
      counter = 0;
    }
    milliseconds = lastMilliseconds;
  } else {
    lastMilliseconds = milliseconds;
    counter = randomBytes(2).readUInt16BE(0) & 0x7ff; // leaves room to count up within the millisecond
  }

  const bytes = randomBytes(16);
  bytes.writeUIntBE(milliseconds, 0, 6);
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The creation time inside a version 7 id. */
export function uuidVersion7Milliseconds(uuid: string): number {
  return Number.parseInt(uuid.replaceAll('-', '').slice(0, 12), 16);
}
