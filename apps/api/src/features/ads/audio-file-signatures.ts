import type { AdUploadContentType } from '@lookup/contracts';

/** How many leading bytes are read to recognise a file. */
export const AUDIO_SIGNATURE_BYTES_TO_READ = 64;

const M4A_BRANDS = new Set(['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42']);

/**
 * True when the file's first bytes are really the declared audio format. A file is judged by its
 * content, never by its name or the type the browser claimed.
 *  - MP3: an ID3 tag ("ID3"), or an MPEG audio frame (sync bits: 0xFF then the top 3 bits set).
 *  - WAV: "RIFF" at 0 and "WAVE" at 8.
 *  - M4A: "ftyp" at 4, with a known audio or ISO brand.
 */
export function isDeclaredAudioFormat(firstBytes: Buffer, declaredType: AdUploadContentType): boolean {
  switch (declaredType) {
    case 'audio/mpeg': {
      const hasId3Tag = firstBytes.subarray(0, 3).toString('latin1') === 'ID3';
      const firstByte = firstBytes[0];
      const secondByte = firstBytes[1];
      const hasFrameSync = firstByte === 0xff && secondByte !== undefined && (secondByte & 0xe0) === 0xe0;
      return hasId3Tag || hasFrameSync;
    }
    case 'audio/wav':
      return firstBytes.subarray(0, 4).toString('latin1') === 'RIFF' && firstBytes.subarray(8, 12).toString('latin1') === 'WAVE';
    case 'audio/mp4':
      return firstBytes.subarray(4, 8).toString('latin1') === 'ftyp' && M4A_BRANDS.has(firstBytes.subarray(8, 12).toString('latin1'));
  }
}
