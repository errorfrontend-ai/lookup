import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { portalApi, SIGNED_IN_USER_QUERY_KEY } from '../../app/portal-api';

/**
 * Ends the session on the server, then forgets everything cached for this person, so the next person
 * on a shared computer sees none of it. The screen moves to Sign in even if the server can't be
 * reached: the cookies expire on their own, and staying signed in on screen would be worse.
 */
export function useSignOut(): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useCallback(async () => {
    try {
      await portalApi.post('/auth/sign-out');
    } catch {
      // Already handled above: the person still leaves.
    }
    queryClient.clear();
    queryClient.setQueryData(SIGNED_IN_USER_QUERY_KEY, null);
    await navigate('/sign-in', { replace: true });
  }, [queryClient, navigate]);
}
