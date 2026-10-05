import type { SignedInPortalUser } from '@lookup/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { portalApi, SIGNED_IN_USER_QUERY_KEY } from '../../app/portal-api';
import { ErrorNotice } from '../../components/error-notice';
import { useSignedInUser } from '../session/use-signed-in-user';

/** Where a signed-in person lands: their first station's ads. */
export function homePathFor(signedInUser: SignedInPortalUser): string {
  const firstStation = signedInUser.stations[0];
  return firstStation ? `/stations/${firstStation.id}/ads` : '/';
}

/**
 * The page the person was sent away from, so signing in takes them back to it. Only paths inside this
 * portal are accepted ("//other.site" or "/\other.site" would leave it).
 */
export function returnPathFrom(locationState: unknown): string | null {
  const from = (locationState as { from?: unknown } | null)?.from;
  return typeof from === 'string' && /^\/(?![/\\])/.test(from) && from !== '/sign-in' ? from : null;
}

export function SignInPage() {
  const signedInUser = useSignedInUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const returnPath = returnPathFrom(location.state);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const emailFieldId = useId();
  const passwordFieldId = useId();

  const signIn = useMutation({
    mutationFn: () => portalApi.post<SignedInPortalUser>('/auth/sign-in', { email, password }),
    onSuccess: (signedIn) => {
      queryClient.setQueryData(SIGNED_IN_USER_QUERY_KEY, signedIn);
      setPassword('');
      void navigate(returnPath ?? homePathFor(signedIn), { replace: true });
    },
  });

  if (signedInUser.data) return <Navigate to={returnPath ?? homePathFor(signedInUser.data)} replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    signIn.mutate();
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10 sm:px-6">
      <div className="flex flex-col gap-1">
        <span className="font-display text-title">Look Up</span>
        <h1 className="text-display">Sign in to your station</h1>
        <p className="text-body text-muted">Upload your clients' ads, add their buttons and set when they air.</p>
      </div>

      <form onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={emailFieldId} className="text-label">
            Email
          </label>
          <input
            id={emailFieldId}
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="min-h-11 rounded-md border border-line bg-surface px-3 text-body"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={passwordFieldId} className="text-label">
            Password
          </label>
          <div className="flex gap-2">
            <input
              id={passwordFieldId}
              type={isPasswordVisible ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="min-h-11 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-body"
            />
            <button
              type="button"
              onClick={() => setIsPasswordVisible((visible) => !visible)}
              aria-pressed={isPasswordVisible}
              className="min-h-11 rounded-md border border-line px-3 text-label"
            >
              {isPasswordVisible ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        {signIn.isError ? <ErrorNotice error={signIn.error} /> : null}

        <button
          type="submit"
          disabled={signIn.isPending || !email || !password}
          className="min-h-12 rounded-md bg-accent px-5 text-label text-on-accent hover:bg-accent-hover disabled:opacity-60"
        >
          {signIn.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
