import type { SignedInPortalUser } from '@lookup/contracts';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/api-client';
import { portalApi, SIGNED_IN_USER_QUERY_KEY } from '../../app/portal-api';

/** The signed-in person and their stations; null when nobody is signed in. */
export function useSignedInUser() {
  return useQuery({
    queryKey: SIGNED_IN_USER_QUERY_KEY,
    queryFn: async (): Promise<SignedInPortalUser | null> => {
      try {
        return await portalApi.get<SignedInPortalUser>('/auth/me');
      } catch (error) {
        if (error instanceof ApiError && error.httpStatus === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}
