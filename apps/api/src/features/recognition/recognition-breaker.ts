import CircuitBreaker from 'opossum';
import { RecognizeJobFailed } from '../../infrastructure/job-queues/recognize-queue.js';

/** Opens at half the attempts failing, once at least this many were made within the window. */
export const BREAKER_MINIMUM_ATTEMPTS = 5;
export const BREAKER_WINDOW_MILLISECONDS = 10_000;
/** After this long open, one trial is let through: success closes it, failure opens it again. */
export const BREAKER_RESET_MILLISECONDS = 10_000;

/**
 * The circuit breaker around "send a clip to a worker and wait" (S3-D17). Timeouts and worker or
 * queue failures count against it; a clip the worker could not read is the listener's problem, not
 * the system's, so it does not. While open, clips are refused at once as busy.
 */
export function createRecognitionBreaker<Arguments extends unknown[], Result>(
  action: (...arguments_: Arguments) => Promise<Result>,
): CircuitBreaker<Arguments, Result> {
  return new CircuitBreaker(action, {
    timeout: false,
    errorThresholdPercentage: 50,
    volumeThreshold: BREAKER_MINIMUM_ATTEMPTS,
    rollingCountTimeout: BREAKER_WINDOW_MILLISECONDS,
    resetTimeout: BREAKER_RESET_MILLISECONDS,
    // A clip the worker read and refused shows the workers are fine. A slow decode does not: it counts.
    errorFilter: (error: unknown) => error instanceof RecognizeJobFailed && error.code === 'INVALID_AUDIO',
  });
}
