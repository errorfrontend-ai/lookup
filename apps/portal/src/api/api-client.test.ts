import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './api-client';

const jsonResponse = (httpStatus: number, body: unknown, requestId = 'request-from-server') =>
  new Response(httpStatus === 204 ? null : JSON.stringify(body), {
    status: httpStatus,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
  });

describe('API client', () => {
  it('sends cookies, JSON and a fresh request id with every call, to the same-origin API path', async () => {
    const fetchFunction = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = createApiClient({ fetchFunction, locks: undefined, createRequestId: () => 'request-1' });
    await client.post('/stations/abc/clients', { name: 'Brand A' });
    expect(fetchFunction).toHaveBeenCalledWith('/api/v1/stations/abc/clients', {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Request-Id': 'request-1', Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{"name":"Brand A"}',
    });
  });

  it('turns the error envelope into an ApiError with the plain message, the fields and the request id', async () => {
    const fetchFunction = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        error: { code: 'VALIDATION_FAILED', message: 'Some details are missing or not valid.', request_id: 'abc-123', fields: [{ path: 'name', code: 'too_small' }] },
      }),
    );
    const client = createApiClient({ fetchFunction, locks: undefined });
    const error = await client.post('/x', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      httpStatus: 400,
      code: 'VALIDATION_FAILED',
      message: 'Some details are missing or not valid.',
      requestId: 'abc-123',
      fields: [{ path: 'name', code: 'too_small' }],
    });
  });

  it('when the access cookie has expired, refreshes once and retries the request once', async () => {
    const fetchFunction = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Please sign in.', request_id: 'r1' } }))
      .mockResolvedValueOnce(jsonResponse(204, null))
      .mockResolvedValueOnce(jsonResponse(200, { ads: [] }));
    const client = createApiClient({ fetchFunction, locks: undefined });
    await expect(client.get('/stations/abc/ads')).resolves.toEqual({ ads: [] });
    expect(fetchFunction.mock.calls.map(([path, init]) => `${init.method} ${path}`)).toEqual([
      'GET /api/v1/stations/abc/ads',
      'POST /api/v1/auth/refresh',
      'GET /api/v1/stations/abc/ads',
    ]);
  });

  it('when the refresh is refused, reports that the session ended and passes the 401 on', async () => {
    const unauthenticated = () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Please sign in.', request_id: 'r1' } });
    const fetchFunction = vi.fn().mockImplementation(async () => unauthenticated());
    const onSessionEnded = vi.fn();
    const client = createApiClient({ fetchFunction, locks: undefined, onSessionEnded });
    await expect(client.get('/auth/me')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(onSessionEnded).toHaveBeenCalledOnce();
    expect(fetchFunction).toHaveBeenCalledTimes(2);
  });

  it('two requests that both find the session expired share one refresh', async () => {
    let refreshCount = 0;
    let firstCalls = 0;
    const fetchFunction = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/api/v1/auth/refresh') {
        refreshCount++;
        return jsonResponse(204, null);
      }
      firstCalls++;
      return firstCalls <= 2 ? jsonResponse(401, { error: { code: 'UNAUTHENTICATED', request_id: 'r' } }) : jsonResponse(200, {});
    });
    const client = createApiClient({ fetchFunction, locks: undefined });
    await Promise.all([client.get('/a'), client.get('/b')]);
    expect(refreshCount).toBe(1);
  });

  it('a failed sign-in is not followed by a refresh attempt', async () => {
    const fetchFunction = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'The email or password is not correct.', request_id: 'r' } }),
    );
    const client = createApiClient({ fetchFunction, locks: undefined });
    await expect(client.post('/auth/sign-in', { email: 'a', password: 'b' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(fetchFunction).toHaveBeenCalledOnce();
  });

  it('a network failure becomes a plain message with the request id that was sent', async () => {
    const fetchFunction = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = createApiClient({ fetchFunction, locks: undefined, createRequestId: () => 'sent-id' });
    await expect(client.get('/x')).rejects.toMatchObject({
      code: 'NETWORK_UNAVAILABLE',
      requestId: 'sent-id',
      message: "We couldn't reach Look Up. Check your connection and try again.",
    });
  });
});
