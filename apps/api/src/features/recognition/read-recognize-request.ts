import { MAXIMUM_CLIP_BYTES } from '@lookup/contracts';
import busboy from 'busboy';
import type { Request } from 'express';
import { AppError } from '../../common/errors/app-error.js';

/** The clip plus a little room for the text fields and the form's own boundaries and headers. */
export const MAXIMUM_RECOGNIZE_BODY_BYTES = MAXIMUM_CLIP_BYTES + 16_384;

export interface RecognizeUpload {
  /** The text fields as sent, for RecognizeRequestFields to check. */
  fields: Record<string, string>;
  audio: Buffer;
}

const tooLarge = (detail: string) => new AppError('PAYLOAD_TOO_LARGE', { publicMessage: 'The recording is too large.', internalDetail: detail });
const unreadable = (detail: string) => new AppError('BAD_REQUEST', { publicMessage: "The recording couldn't be read. Please try again.", internalDetail: detail });

/**
 * Reads the `multipart/form-data` body of POST /recognize as it streams in, holding at most the
 * 256 KiB clip in memory: a bigger body is refused (413) the moment it passes the limit, never read
 * to the end or buffered whole (S3-REQUEST-17, -18). Parser messages stay in the log; the caller gets
 * plain words. Field values are checked afterwards against the contract, like any other request.
 */
export function readRecognizeRequest(request: Request, readLimitMilliseconds: number): Promise<RecognizeUpload> {
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
    let audioBytes = 0;
    let receivedBytes = 0;
    let isSettled = false;

    const fail = (error: AppError) => {
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
      if (information.nameTruncated || information.valueTruncated) {
        fail(new AppError('VALIDATION_FAILED', { fields: [{ path: name.slice(0, 64), code: 'too_big' }], internalDetail: 'a form field was too long' }));
        return;
      }
      fields[name] = value;
    });
    parser.on('file', (name, stream) => {
      stream.on('error', () => undefined); // the parser reports the same problem once, below
      if (name !== 'audio' || hasAudio) {
        // An unexpected file part is reported like an unknown field.
        fields[name] = '';
        stream.resume();
        return;
      }
      hasAudio = true;
      stream.on('data', (chunk: Buffer) => {
        audioChunks.push(chunk);
        audioBytes += chunk.length;
      });
      stream.on('limit', () => fail(tooLarge(`audio part passed ${MAXIMUM_CLIP_BYTES} bytes`)));
    });
    for (const limitEvent of ['fieldsLimit', 'filesLimit', 'partsLimit'] as const) {
      parser.on(limitEvent, () => fail(unreadable(`multipart ${limitEvent}`)));
    }
    parser.on('error', (error: Error) => fail(unreadable(`multipart parse failed: ${error.message}`)));
    parser.on('close', () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(readTimer);
      if (!hasAudio) {
        reject(new AppError('VALIDATION_FAILED', { fields: [{ path: 'audio', code: 'invalid_type' }], internalDetail: 'no audio part' }));
        return;
      }
      if (audioBytes > MAXIMUM_CLIP_BYTES) {
        reject(tooLarge(`audio part of ${audioBytes} bytes`));
        return;
      }
      resolve({ fields, audio: Buffer.concat(audioChunks) });
    });
    request.pipe(parser);
  });
}
