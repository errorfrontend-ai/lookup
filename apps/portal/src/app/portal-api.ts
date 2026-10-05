import { QueryClient } from '@tanstack/react-query';
import { ApiError, createApiClient } from '../api/api-client';

/** Shared query cache. Errors a person caused (4xx) are not retried; network blips are retried twice. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !(error instanceof ApiError && error.httpStatus >= 400 && error.httpStatus < 500) && failureCount < 2,
      refetchOnWindowFocus: false,
    },
  },
});

export const SIGNED_IN_USER_QUERY_KEY = ['signed-in-user'] as const;

/** When the session can't be refreshed, forget who was signed in; the route guard then shows Sign in. */
export const portalApi = createApiClient({
  onSessionEnded: () => queryClient.setQueryData(SIGNED_IN_USER_QUERY_KEY, null),
});
