import type { SignedInPortalUser } from '@lookup/contracts';
import { vi } from 'vitest';

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (body: unknown) => Response | Promise<Response>;

export function jsonResponse(status: number, body: unknown, requestId = 'request-id-from-server'): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
  });
}

export function errorResponse(status: number, code: string, message: string, requestId = 'a1b2c3d4', fields?: unknown[]): Response {
  return jsonResponse(status, { error: { code, message, request_id: requestId, ...(fields ? { fields } : {}) } }, requestId);
}

/**
 * Replaces fetch with a small fake of the API. Handlers are keyed "METHOD /path" (the part after
 * /api/v1). Anything not handled answers 404, like the real API.
 */
export function installFakeApi(handlers: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetchFake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^\/api\/v1/, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path, body });
    const handler = handlers[`${method} ${path}`];
    return handler ? handler(body) : errorResponse(404, 'NOT_FOUND', 'We could not find that.');
  });
  vi.stubGlobal('fetch', fetchFake);
  return { calls, fetchFake };
}

export function signedInUserWith(stations: Partial<SignedInPortalUser['stations'][number]>[] = [{}]): SignedInPortalUser {
  return {
    user: { id: '0190f1a2-0000-7000-8000-000000000001', fullName: 'Chanda Mwale', email: 'chanda@example.test' },
    stations: stations.map((station, index) => ({
      id: `0190f1a2-0000-7000-8000-00000000010${index}`,
      name: `Station ${index === 0 ? 'A' : 'B'}`,
      frequencyLabel: index === 0 ? '98.1 FM' : '89.5 FM',
      status: 'ACTIVE',
      role: 'OWNER',
      ...station,
    })),
  };
}

/** Text that must never reach the screen: exception names, stack frames, file paths. */
export const INTERNAL_DETAIL_PATTERN = /TypeError|ReferenceError|at \S+ \(|\.tsx?:\d+|node_modules|SQLSTATE|Traceback/;
