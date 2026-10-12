import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuidVersion7, uuidVersion7Milliseconds } from '../src/common/identifiers/uuid-version-7.js';
import { isListenerRoute } from '../src/common/rate-limiting/limit-requests-per-client-address.js';
import { assertClipSignature, correctCaptureTime } from '../src/features/recognition/clip-checks.js';
import { BREAKER_RESET_MILLISECONDS, createRecognitionBreaker } from '../src/features/recognition/recognition-breaker.js';
import { RecognizeJobFailed, RecognizeWaitTimedOut } from '../src/infrastructure/job-queues/recognize-queue.js';

/** The recognition route's rules on their own, without the database, the queue or HTTP. */

describe('UUID version 7 recognition ids', () => {
  it('have the version 7 shape and carry the time they were made', () => {
    const id = uuidVersion7(() => 1_791_400_000_123);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidVersion7Milliseconds(id)).toBe(1_791_400_000_123);
  });

  it('sort in the order they were made, even many in one millisecond', () => {
    const made = Array.from({ length: 3_000 }, () => uuidVersion7(() => 1_791_400_001_000));
    expect([...made].sort()).toEqual(made);
    expect(new Set(made).size).toBe(made.length);
  });
});

describe('the capture time', () => {
  const receivedAt = new Date('2026-10-07T08:00:00Z');

  it('is corrected by how far the phone clock is off, judged from when it says it sent the clip', () => {
    // The phone's clock is 3 hours slow: it says it heard the clip at 04:59:50 and sent it at 05:00:00.
    const corrected = correctCaptureTime({
      capturedAt: new Date('2026-10-07T04:59:50Z'),
      sentAt: new Date('2026-10-07T05:00:00Z'),
      receivedAt,
      isDeferredByApp: false,
    });
    expect(corrected.effectiveCapturedAt.toISOString()).toBe('2026-10-07T07:59:50.000Z');
    expect(corrected.clockSkewMilliseconds).toBe(3 * 60 * 60 * 1000);
    expect(corrected.isDeferred).toBe(false);
  });

  it('P4-CLOCK-01: is corrected the same way for a phone 3 hours fast, and left as it is for an exact clock', () => {
    // 3 hours fast: the phone says it heard the clip at 10:59:50 and sent it at 11:00:00, when the server's clock says 08:00:00.
    const fast = correctCaptureTime({ capturedAt: new Date('2026-10-07T10:59:50Z'), sentAt: new Date('2026-10-07T11:00:00Z'), receivedAt, isDeferredByApp: false });
    expect(fast.effectiveCapturedAt.toISOString()).toBe('2026-10-07T07:59:50.000Z');
    expect(fast.clockSkewMilliseconds).toBe(-3 * 60 * 60 * 1000);
    expect(fast.isDeferred).toBe(false);
    // An exact clock: nothing moves, and the skew is a stored 0, never left out.
    const exact = correctCaptureTime({ capturedAt: new Date('2026-10-07T07:59:50Z'), sentAt: receivedAt, receivedAt, isDeferredByApp: false });
    expect(exact.effectiveCapturedAt.toISOString()).toBe('2026-10-07T07:59:50.000Z');
    expect(exact.clockSkewMilliseconds).toBe(0);
  });

  it('refuses a clip heard more than 24 hours ago, and one from more than 2 minutes in the future', () => {
    const capture = (capturedAt: string) => () =>
      correctCaptureTime({ capturedAt: new Date(capturedAt), sentAt: receivedAt, receivedAt, isDeferredByApp: true });
    expect(capture('2026-10-06T07:59:59Z')).toThrow(expect.objectContaining({ code: 'CAPTURE_EXPIRED' }));
    expect(capture('2026-10-06T08:00:00Z')).not.toThrow();
    expect(capture('2026-10-07T08:02:01Z')).toThrow(expect.objectContaining({ code: 'CAPTURE_TIME_INVALID' }));
    expect(capture('2026-10-07T08:02:00Z')).not.toThrow();
  });

  it('counts a clip as deferred when the app says so, or when it arrives over two minutes after it was heard', () => {
    const at = (capturedAt: string, isDeferredByApp: boolean) =>
      correctCaptureTime({ capturedAt: new Date(capturedAt), sentAt: receivedAt, receivedAt, isDeferredByApp }).isDeferred;
    expect(at('2026-10-07T07:58:00Z', false)).toBe(false);
    expect(at('2026-10-07T07:57:59Z', false)).toBe(true);
    expect(at('2026-10-07T07:59:59Z', true)).toBe(true);
  });

  it('stores the exact skew of a phone clock off by weeks', () => {
    // About 279 days: far beyond the 2,147,483,647 milliseconds an integer column could hold (P4-D18).
    const corrected = correctCaptureTime({ capturedAt: new Date('2026-01-01T00:00:00Z'), sentAt: new Date('2026-01-01T00:00:05Z'), receivedAt, isDeferredByApp: false });
    expect(corrected.clockSkewMilliseconds).toBe(receivedAt.getTime() - Date.parse('2026-01-01T00:00:05Z'));
    expect(corrected.clockSkewMilliseconds).toBeGreaterThan(2 ** 31);
    expect(corrected.effectiveCapturedAt.toISOString()).toBe('2026-10-07T07:59:55.000Z');
  });
});

describe('the clip’s first bytes', () => {
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(64)]);
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)]);

  it('must be the container of the codec sent', () => {
    expect(() => assertClipSignature(m4a, 'aac')).not.toThrow();
    expect(() => assertClipSignature(ogg, 'opus')).not.toThrow();
    for (const [bytes, codec] of [[ogg, 'aac'], [m4a, 'opus'], [Buffer.from('this is plain text named clip.m4a'), 'aac'], [Buffer.alloc(0), 'aac'], [Buffer.from('\x89PNG\r\n\x1a\n'), 'aac']] as const) {
      expect(() => assertClipSignature(bytes, codec)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' }));
    }
  });
});

describe('the recognition circuit breaker', () => {
  afterEach(() => vi.useRealTimers());

  it('opens after repeated timeouts, refuses at once while open, and half-opens after its reset time', async () => {
    vi.useFakeTimers();
    let shouldFail = true;
    const breaker = createRecognitionBreaker(async () => {
      if (shouldFail) throw new RecognizeWaitTimedOut(2_500);
      return 'answered';
    });
    for (let attempt = 0; attempt < 5; attempt += 1) await expect(breaker.fire()).rejects.toBeInstanceOf(RecognizeWaitTimedOut);
    expect(breaker.opened).toBe(true);
    await expect(breaker.fire()).rejects.toMatchObject({ code: 'EOPENBREAKER' });

    // The trial after the reset time fails: open again.
    await vi.advanceTimersByTimeAsync(BREAKER_RESET_MILLISECONDS);
    expect(breaker.halfOpen).toBe(true);
    await expect(breaker.fire()).rejects.toBeInstanceOf(RecognizeWaitTimedOut);
    expect(breaker.opened).toBe(true);

    // The next trial succeeds: closed.
    await vi.advanceTimersByTimeAsync(BREAKER_RESET_MILLISECONDS);
    shouldFail = false;
    await expect(breaker.fire()).resolves.toBe('answered');
    expect(breaker.closed).toBe(true);
    breaker.shutdown();
  });

  it('does not count clips the worker could not read: that is the listener’s problem, not the system’s', async () => {
    const breaker = createRecognitionBreaker(async () => {
      throw new RecognizeJobFailed('INVALID_AUDIO');
    });
    for (let attempt = 0; attempt < 10; attempt += 1) await expect(breaker.fire()).rejects.toBeInstanceOf(RecognizeJobFailed);
    expect(breaker.closed).toBe(true);
    breaker.shutdown();
  });

  it('turns an unknown worker code into ENGINE_FAILED, so worker text never travels on', () => {
    expect(new RecognizeJobFailed('Traceback (most recent call last): File "/app/workers/recognize.py"').code).toBe('ENGINE_FAILED');
    expect(new RecognizeJobFailed('LOOKUP_TIMEOUT').code).toBe('LOOKUP_TIMEOUT');
  });
});

describe('the listener routes’ per-address ceiling', () => {
  it('covers exactly the listener app’s routes', () => {
    expect(isListenerRoute('/api/v1/recognize')).toBe(true);
    expect(isListenerRoute('/api/v1/installs/')).toBe(true);
    expect(isListenerRoute('/api/v1/auth/sign-in')).toBe(false);
    expect(isListenerRoute('/api/v1/recognize-something-else')).toBe(false);
  });
});
