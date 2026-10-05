/**
 * The smallest byte sequences each format is recognised by. The API only reads the first bytes when an
 * upload completes (decoding the whole file is the ingest worker's job), so these are enough to prove
 * the check, and small enough to keep tests fast.
 */
export function mp3Bytes(sizeBytes = 2048): Buffer {
  const bytes = Buffer.alloc(sizeBytes);
  bytes.write('ID3', 0, 'latin1');
  bytes[3] = 0x04;
  return bytes;
}

export function wavBytes(sizeBytes = 2048): Buffer {
  const bytes = Buffer.alloc(sizeBytes);
  bytes.write('RIFF', 0, 'latin1');
  bytes.writeUInt32LE(sizeBytes - 8, 4);
  bytes.write('WAVE', 8, 'latin1');
  bytes.write('fmt ', 12, 'latin1');
  return bytes;
}

export function m4aBytes(sizeBytes = 2048): Buffer {
  const bytes = Buffer.alloc(sizeBytes);
  bytes.writeUInt32BE(32, 0);
  bytes.write('ftyp', 4, 'latin1');
  bytes.write('M4A ', 8, 'latin1');
  return bytes;
}

/** Text pretending to be an MP3: the right size and type, the wrong content. */
export function notAudioBytes(sizeBytes = 2048): Buffer {
  return Buffer.from('<html><script>alert(1)</script></html>'.padEnd(sizeBytes, ' '), 'latin1');
}
