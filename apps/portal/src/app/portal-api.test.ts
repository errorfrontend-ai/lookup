import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/api-client';
import { shouldRetryQuery } from './portal-api';

describe('which failed requests the portal tries again', () => {
  it('does not retry what the person caused (a refusal, a missing page, an expired session)', () => {
    for (const httpStatus of [400, 401, 403, 404, 409, 429]) {
      expect(shouldRetryQuery(0, new ApiError(httpStatus, 'X', 'x', 'id')), String(httpStatus)).toBe(false);
    }
  });

  it('retries server trouble and a lost connection, twice, then gives up', () => {
    for (const error of [new ApiError(500, 'INTERNAL', 'x', 'id'), new ApiError(503, 'SERVICE_UNAVAILABLE', 'x', 'id'), new ApiError(0, 'NETWORK_UNAVAILABLE', 'x', 'id'), new TypeError('x')]) {
      expect(shouldRetryQuery(0, error)).toBe(true);
      expect(shouldRetryQuery(1, error)).toBe(true);
      expect(shouldRetryQuery(2, error)).toBe(false);
    }
  });
});
