import type { SignedInPortalUser } from '@lookup/contracts';
import { QueryClient } from '@tanstack/react-query';
import { ApiError, createApiClient } from '../api/api-client';

/** Errors a person caused (4xx) are not retried; server and network trouble is retried twice. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const isCausedByThePerson = error instanceof ApiError && error.httpStatus >= 400 && error.httpStatus < 500;
  return !isCausedByThePerson && failureCount < 2;
}

/** Shared query cache. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: shouldRetryQuery, refetchOnWindowFocus: false } },
});

export const SIGNED_IN_USER_QUERY_KEY = ['signed-in-user'] as const;

/**
 * A new session (signing in, signing up, joining from an invitation) starts with nothing cached from before: an ended
 * session's failed answers ("Please sign in.") or another person's pages would otherwise show until each page refetched.
 * Only the signed-in person's own entry is kept, and replaced when [signedInUser] is given.
 */
export function startFreshSession(signedInUser?: SignedInPortalUser): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SIGNED_IN_USER_QUERY_KEY[0] });
  if (signedInUser) queryClient.setQueryData(SIGNED_IN_USER_QUERY_KEY, signedInUser);
}

/** When the session can't be refreshed, forget who was signed in; the route guard then shows Sign in. */
export const portalApi = createApiClient({
  onSessionEnded: () => queryClient.setQueryData(SIGNED_IN_USER_QUERY_KEY, null),
});
