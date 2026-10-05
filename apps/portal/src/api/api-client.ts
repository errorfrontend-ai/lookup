/**
 * The portal's one way to talk to the API.
 * - Same origin (/api/v1, forwarded to the API in development), with cookies; tokens never touch
 *   JavaScript, local storage or URLs.
 * - Every call sends a fresh X-Request-Id, and every error carries the id back, so a station can
 *   quote it to support and it can be found in the logs.
 * - When the 15-minute access cookie has expired (401), the client refreshes the session once and
 *   retries once. Tabs share one refresh through a Web Lock, so two tabs never spend the same
 *   refresh token (which the API would treat as theft and end the session).
 */
export interface FieldProblem {
  path: string;
  code: string;
}

export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly requestId: string,
    readonly fields: FieldProblem[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const API_BASE_PATH = '/api/v1';
const SESSION_REFRESH_LOCK = 'lookup-session-refresh';
const NETWORK_FAILURE_MESSAGE = "We couldn't reach Look Up. Check your connection and try again.";

export interface ApiClient {
  get<Result>(path: string): Promise<Result>;
  post<Result>(path: string, body?: unknown): Promise<Result>;
  put<Result>(path: string, body: unknown): Promise<Result>;
}

export interface ApiClientDependencies {
  fetchFunction?: typeof fetch;
  locks?: Pick<LockManager, 'request'> | undefined;
  createRequestId?: () => string;
  /** Called when the session can't be refreshed, so the app can send the person to Sign in. */
  onSessionEnded?: () => void;
}

export function createApiClient(dependencies: ApiClientDependencies = {}): ApiClient {
  const fetchFunction = dependencies.fetchFunction ?? ((input, init) => fetch(input, init));
  const locks = 'locks' in dependencies ? dependencies.locks : globalThis.navigator?.locks;
  const createRequestId = dependencies.createRequestId ?? (() => crypto.randomUUID());
  let refreshInThisTab: Promise<boolean> | null = null;

  async function send(method: string, path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'X-Request-Id': createRequestId(), Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetchFunction(`${API_BASE_PATH}${path}`, {
        method,
        credentials: 'include',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'NETWORK_UNAVAILABLE', NETWORK_FAILURE_MESSAGE, headers['X-Request-Id'] as string);
    }
  }

  function refreshSession(): Promise<boolean> {
    refreshInThisTab ??= (async () => {
      const refreshOnce = async () => (await send('POST', '/auth/refresh', undefined)).ok;
      try {
        return locks ? await locks.request(SESSION_REFRESH_LOCK, refreshOnce) : await refreshOnce();
      } catch {
        return false;
      } finally {
        refreshInThisTab = null;
      }
    })();
    return refreshInThisTab;
  }

  async function request<Result>(method: string, path: string, body: unknown): Promise<Result> {
    let response = await send(method, path, body);
    const mayRefresh = response.status === 401 && !path.startsWith('/auth/sign-in') && !path.startsWith('/auth/refresh');
    if (mayRefresh) {
      if (await refreshSession()) response = await send(method, path, body);
      if (response.status === 401) dependencies.onSessionEnded?.();
    }
    if (!response.ok) throw await toApiError(response);
    if (response.status === 204) return undefined as Result;
    return (await response.json()) as Result;
  }

  return {
    get: (path) => request('GET', path, undefined),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
  };
}

async function toApiError(response: Response): Promise<ApiError> {
  const requestId = response.headers.get('X-Request-Id') ?? 'unknown';
  try {
    const envelope = (await response.json()) as { error?: { code?: string; message?: string; request_id?: string; fields?: FieldProblem[] } };
    const error = envelope.error ?? {};
    return new ApiError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.message ?? 'Something went wrong. Please try again.',
      error.request_id ?? requestId,
      Array.isArray(error.fields) ? error.fields : [],
    );
  } catch {
    return new ApiError(response.status, 'UNKNOWN', 'Something went wrong. Please try again.', requestId);
  }
}
