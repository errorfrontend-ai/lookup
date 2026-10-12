import type { RecognitionCodec } from '@lookup/contracts';
import { AppError } from '../../common/errors/app-error.js';

/**
 * The clip's first bytes must be the container its codec comes in: AAC in MP4/M4A starts with a box
 * whose type is `ftyp` (bytes 4 to 8), Opus in Ogg starts with `OggS`. The declared content type and
 * the file name are never trusted (S3-REQUEST-20, -21).
 */
export function assertClipSignature(audio: Buffer, codec: RecognitionCodec): void {
  const looksLike = codec === 'aac' ? audio.subarray(4, 8).toString('latin1') === 'ftyp' : audio.subarray(0, 4).toString('latin1') === 'OggS';
  if (!looksLike) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
      publicMessage: "That recording isn't in a supported format.",
      internalDetail: `clip first bytes do not match codec ${codec} (${audio.length} bytes)`,
    });
  }
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const FUTURE_ALLOWANCE_MILLISECONDS = 2 * 60 * 1000;
const DEFERRED_AFTER_MILLISECONDS = 120 * 1000;

export interface CorrectedCaptureTime {
  /** When the clip was heard, on the server's clock. */
  effectiveCapturedAt: Date;
  /** How far the phone's clock was off: the receipt time minus its "sent at". Always stored, exactly (a bigint column). */
  clockSkewMilliseconds: number;
  /** Held back on the phone, or arrived long after it was heard. */
  isDeferred: boolean;
}

/**
 * The phone's clock may be wrong, so the capture time is corrected by how far the phone's "sent at"
 * is from the moment the server received it (O11): effective = captured_at + (received − sent_at).
 * A clip heard more than 24 hours ago is refused (422 CAPTURE_EXPIRED), one claiming to be from more
 * than 2 minutes in the future too (422 CAPTURE_TIME_INVALID); both before anything is stored, so the
 * database's own check never fails (S3-ERRORS-03).
 */
export function correctCaptureTime(times: { capturedAt: Date; sentAt: Date; receivedAt: Date; isDeferredByApp: boolean }): CorrectedCaptureTime {
  const skew = times.receivedAt.getTime() - times.sentAt.getTime();
  const effectiveCapturedAt = new Date(times.capturedAt.getTime() + skew);
  const age = times.receivedAt.getTime() - effectiveCapturedAt.getTime();
  if (age > DAY_MILLISECONDS) {
    throw new AppError('CAPTURE_EXPIRED', { internalDetail: `clip heard ${Math.round(age / 60_000)} minutes ago` });
  }
  if (-age > FUTURE_ALLOWANCE_MILLISECONDS) {
    throw new AppError('CAPTURE_TIME_INVALID', { internalDetail: `clip claims to be ${Math.round(-age / 1000)} seconds in the future` });
  }
  return {
    effectiveCapturedAt,
    clockSkewMilliseconds: skew,
    isDeferred: times.isDeferredByApp || age > DEFERRED_AFTER_MILLISECONDS,
  };
}
