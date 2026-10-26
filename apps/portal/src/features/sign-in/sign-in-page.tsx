import type { SignedInPortalUser } from '@lookup/contracts';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { portalApi, startFreshSession } from '../../app/portal-api';
import { ErrorNotice } from '../../components/error-notice';
import { useSignedInUser } from '../session/use-signed-in-user';
import { stationHomePath } from '../stations/station-home-path';

/**
 * Where a signed-in person lands: a super admin at the second factor, then the applications (P5A design §4.1);
 * everyone else at their first approved station (a station still applying or suspended has no way to the others), or
 * their first station when none is approved yet; a client at their adverts.
 */
export function homePathFor(signedInUser: SignedInPortalUser): string {
  if (signedInUser.user.platformRole === 'SUPER_ADMIN') return signedInUser.isTwoFactorCodeNeeded ? '/two-factor' : '/admin/applications';
  const firstStation = signedInUser.stations.find((station) => station.status === 'ACTIVE') ?? signedInUser.stations[0];
  if (firstStation) return stationHomePath(firstStation);
  return signedInUser.clientAccesses.length > 0 ? '/client' : '/';
}

/**
 * The page the person was sent away from, so signing in takes them back to it. Only paths inside this
 * portal are accepted ("//other.site" or "/\other.site" would leave it).
 */
export function returnPathFrom(locationState: unknown): string | null {
  const from = (locationState as { from?: unknown } | null)?.from;
  return typeof from === 'string' && /^\/(?![/\\])/.test(from) && from !== '/sign-in' ? from : null;
}

/** A path's segments as the router reads them: without query or fragment, each percent-decoded; null if one can't be. */
function routerSegmentsOf(path: string): string[] | null {
  const [pathOnly = ''] = path.split(/[?#]/);
  try {
    return pathOnly.split('/').slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** The part of the portal a path is in ('stations', 'client', 'admin', '' for the home …), read as the router reads it. */
export function portalAreaOf(path: string): string | null {
  const segments = routerSegmentsOf(path);
  return segments === null ? null : (segments[0] ?? '').toLowerCase();
}

/**
 * The page to go back to after signing in, only when the person who signed in can open it. The page left open may be
 * someone else's (a shared computer, an old tab): another station's pages, the super admin's console, another client's
 * advert. Then they land at their own home instead of on a "not found". Paths are read as the router reads them (decoded,
 * capital letters ignored), and only the pages a sign-in can come from are kept: the person's own stations, the console
 * for a super admin, the client area, the invitation page (how an invited person accepts; only for the invited email
 * when the page named it, `forEmail`) and "/". An advert of another client at a station the person also follows can only
 * be told apart by asking for it: the advert page sends a person just signed in (`afterSignIn`) to their home instead.
 */
export function returnPathFor(signedInUser: SignedInPortalUser, locationState: unknown): string | null {
  const from = returnPathFrom(locationState);
  const segments = from === null ? null : routerSegmentsOf(from);
  if (from === null || segments === null) return null;
  const [area = '', ...rest] = segments;
  const isSuperAdmin = signedInUser.user.platformRole === 'SUPER_ADMIN';
  switch (area.toLowerCase()) {
    case '':
      return segments.length === 1 ? from : null;
    case 'invitations': {
      const forEmail = (locationState as { forEmail?: unknown } | null)?.forEmail;
      const isForThisPerson = typeof forEmail !== 'string' || forEmail.toLowerCase() === signedInUser.user.email.toLowerCase();
      return rest.length === 1 && rest[0]?.toLowerCase() === 'accept' && isForThisPerson ? from : null;
    }
    case 'stations':
      return signedInUser.stations.some((station) => station.id === rest[0]) ? from : null;
    case 'admin':
    case 'two-factor':
      return isSuperAdmin ? from : null;
    case 'client': {
      // A station's people and super admins have their own home; the client area is for clients, and for a person with
      // no station at all, whom it tells when a station has taken their access away (P5C-ONBOARDING-06).
      if (isSuperAdmin || (signedInUser.clientAccesses.length === 0 && signedInUser.stations.length > 0)) return null;
      // With no access left, every client page would refuse them: the client home is the one that says why.
      if (signedInUser.clientAccesses.length === 0) return '/client';
      const isAdvertPage = rest[0]?.toLowerCase() === 'stations' && rest[1] !== undefined;
      if (isAdvertPage && !signedInUser.clientAccesses.some((access) => access.stationId === rest[1])) return '/client';
      return from;
    }
    default:
      return null;
  }
}

export function SignInPage() {
  const signedInUser = useSignedInUser();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const emailFieldId = useId();
  const passwordFieldId = useId();

  const signIn = useMutation({
    mutationFn: () => portalApi.post<SignedInPortalUser>('/auth/sign-in', { email, password }),
    onSuccess: (signedIn) => {
      startFreshSession(signedIn);
      setPassword('');
      void navigate(returnPathFor(signedIn, location.state) ?? homePathFor(signedIn), { replace: true, state: { afterSignIn: true } });
    },
  });

  if (signedInUser.data) return <Navigate to={returnPathFor(signedInUser.data, location.state) ?? homePathFor(signedInUser.data)} replace state={{ afterSignIn: true }} />;

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
