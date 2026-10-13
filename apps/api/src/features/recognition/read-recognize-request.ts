import { MAXIMUM_CLIP_BYTES } from '@lookup/contracts';
import busboy from 'busboy';
import type { Request } from 'express';
import { AppError } from '../../common/errors/app-error.js';

/** The clip plus a little room for the text fields and the form's own boundaries and headers. */
export const MAXIMUM_RECOGNIZE_BODY_BYTES = MAXIMUM_CLIP_BYTES + 16_384;

export interface RecognizeUpload {
  /** The text fields as sent, for RecognizeRequestFields to check. */
  fields: Record<string, string>;
  /** The clip, or null when the body had no audio part. */
  audio: Buffer | null;
  /** A part came after the audio part, which must be last (contract §1.2, P4-DEFERRED-13). */
  hasPartAfterAudio: boolean;
}

/**
 * Called once, when the audio part begins, with the text fields that came before it. No audio is read until it
 * resolves (the clip waits in the connection: backpressure), so the caller can take its place in flight and count
 * the request first (P4 design §5.2, step 7). If it throws, the body is refused with that error and its audio is
 * never read.
 */
export type BeforeReadingAudio = (fieldsBeforeAudio: Readonly<Record<string, string>>) => Promise<void>;

const tooLarge = (detail: string) => new AppError('PAYLOAD_TOO_LARGE', { publicMessage: 'The recording is too large.', internalDetail: detail });
const unreadable = (detail: string) => new AppError('BAD_REQUEST', { publicMessage: "The recording couldn't be read. Please try again.", internalDetail: detail });

/**
 * Reads the `multipart/form-data` body of POST /recognize as it streams in, holding at most the
 * 256 KiB clip in memory: a bigger body is refused (413) the moment it passes the limit, never read
 * to the end or buffered whole (S3-REQUEST-17, -18). The text fields come first; when the audio part
 * begins, `beforeReadingAudio` decides whether to read it at all. Parser messages stay in the log; the
 * caller gets plain words. Field values are checked afterwards against the contract, like any other request.
 */
export function readRecognizeRequest(request: Request, readLimitMilliseconds: number, beforeReadingAudio: BeforeReadingAudio): Promise<RecognizeUpload> {
  if (!/^multipart\/form-data\s*;/i.test(request.headers['content-type'] ?? '')) {
    return Promise.reject(
      new AppError('UNSUPPORTED_MEDIA_TYPE', { publicMessage: 'Send the recording as a multipart form.', internalDetail: 'recognize body is not multipart' }),
    );
  }
  const declaredLength = Number(request.headers['content-length'] ?? Number.NaN);
  if (declaredLength > MAXIMUM_RECOGNIZE_BODY_BYTES) return Promise.reject(tooLarge(`declared body of ${declaredLength} bytes`));

  return new Promise<RecognizeUpload>((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: request.headers,
        // One byte past the limit, so a clip of exactly the limit is not flagged; the length is checked below.
        limits: { fileSize: MAXIMUM_CLIP_BYTES + 1, files: 1, fields: 12, parts: 14, fieldSize: 256, fieldNameSize: 64 },
      });
    } catch {
      reject(unreadable('multipart headers could not be read'));
      return;
    }
    const fields: Record<string, string> = {};
    const audioChunks: Buffer[] = [];
    let hasAudio = false;
    let hasPartAfterAudio = false;
    let audioBytes = 0;
    let receivedBytes = 0;
    let isSettled = false;

    const fail = (error: unknown) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(readTimer);
      request.unpipe(parser);
      parser.removeAllListeners();
      parser.on('error', () => undefined);
      reject(error);
    };

    const readTimer = setTimeout(
      () =>
        fail(
          new AppError('BAD_REQUEST', {
            publicMessage: 'The recording took too long to arrive. Please try again.',
            internalDetail: `clip not received within ${readLimitMilliseconds} ms`,
          }),
        ),
      readLimitMilliseconds,
    );

    request.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAXIMUM_RECOGNIZE_BODY_BYTES) fail(tooLarge(`body passed ${MAXIMUM_RECOGNIZE_BODY_BYTES} bytes`));
    });
    request.on('aborted', () => fail(unreadable('the client stopped sending')));
    request.on('error', () => fail(unreadable('the request stream failed')));

    parser.on('field', (name, value, information) => {
      if (hasAudio) hasPartAfterAudio = true;
      if (information.nameTruncated || information.valueTruncated) {
        fail(new AppError('VALIDATION_FAILED', { fields: [{ path: name.slice(0, 64), code: 'too_big' }], internalDetail: 'a form field was too long' }));
        return;
      }
      fields[name] = value;
    });
    parser.on('file', (name, stream) => {
      stream.on('error', () => undefined); // the parser reports the same problem once, below
      if (name !== 'audio' || hasAudio) {
        // An unexpected file part is reported like an unknown field; any part after the audio breaks the order.
        if (hasAudio) hasPartAfterAudio = true;
        else fields[name] = '';
        stream.resume();
        return;
      }
      hasAudio = true;
      stream.on('limit', () => fail(tooLarge(`audio part passed ${MAXIMUM_CLIP_BYTES} bytes`)));
      // Nothing reads the clip until the caller has decided: the parser stops, and so does the connection.
      beforeReadingAudio({ ...fields }).then(
        () => {
          if (isSettled) return;
          stream.on('data', (chunk: Buffer) => {
            audioChunks.push(chunk);
            audioBytes += chunk.length;
          });
        },
        (error: unknown) => fail(error),
      );
    });
    for (const limitEvent of ['fieldsLimit', 'filesLimit', 'partsLimit'] as const) {
      parser.on(limitEvent, () => fail(unreadable(`multipart ${limitEvent}`)));
    }
    parser.on('error', (error: Error) => fail(unreadable(`multipart parse failed: ${error.message}`)));
    parser.on('close', () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(readTimer);
      if (audioBytes > MAXIMUM_CLIP_BYTES) {
        reject(tooLarge(`audio part of ${audioBytes} bytes`));
        return;
      }
      resolve({ fields, audio: hasAudio ? Buffer.concat(audioChunks) : null, hasPartAfterAudio });
    });
    request.pipe(parser);
  });
}
