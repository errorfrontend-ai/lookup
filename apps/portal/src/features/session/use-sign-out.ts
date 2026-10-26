import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { portalApi, SIGNED_IN_USER_QUERY_KEY } from '../../app/portal-api';
import { forgetAllDrafts } from './unsaved-answers';

/**
 * Ends the session on the server, then forgets everything cached for this person, so the next person
 * on a shared computer sees none of it. The screen moves to Sign in even if the server can't be
 * reached: the cookies expire on their own, and staying signed in on screen would be worse.
 * [returnTo] is where signing in again leads (an invitation waiting for the right account, the client area); the
 * sign-in page still keeps it only for a person who can open it, and an invitation only for [forEmail] when given.
 */
export function useSignOut(): (options?: { returnTo?: string; forEmail?: string }) => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useCallback(async (options?: { returnTo?: string; forEmail?: string }) => {
    try {
      await portalApi.post('/auth/sign-out');
    } catch {
      // Already handled above: the person still leaves.
    }
    queryClient.clear();
    forgetAllDrafts();
    queryClient.setQueryData(SIGNED_IN_USER_QUERY_KEY, null);
    await navigate('/sign-in', { replace: true, state: options?.returnTo ? { from: options.returnTo, forEmail: options.forEmail } : undefined });
  }, [queryClient, navigate]);
}
