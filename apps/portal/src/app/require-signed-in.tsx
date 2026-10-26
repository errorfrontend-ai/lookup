import { Navigate, Outlet, useLocation } from 'react-router';
import { ErrorNotice } from '../components/error-notice';
import { LoadingScreen, NoStationPage } from '../components/plain-pages';
import { useSignOut } from '../features/session/use-sign-out';
import { useSignedInUser } from '../features/session/use-signed-in-user';
import { homePathFor, portalAreaOf, returnPathFrom } from '../features/sign-in/sign-in-page';

/** Lets signed-in people through; everyone else goes to Sign in. */
export function RequireSignedIn() {
  const signedInUser = useSignedInUser();
  const location = useLocation();
  const signOut = useSignOut();

  if (signedInUser.isPending) return <LoadingScreen />;
  if (signedInUser.isError) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4">
        <ErrorNotice error={signedInUser.error} title="We couldn't load your account" />
        <button
          type="button"
          onClick={() => void signedInUser.refetch()}
          className="min-h-11 self-start rounded-md border border-line px-4 text-label"
        >
          Try again
        </button>
      </main>
    );
  }
  if (!signedInUser.data) {
    // On the second-factor page, the page to come back to is the console page waiting behind it.
    const waitingPage = portalAreaOf(location.pathname) === 'two-factor' ? returnPathFrom(location.state) : null;
    // The address's settings come back too (a range, a tab): `?…` is part of the page.
    return <Navigate to="/sign-in" replace state={{ from: waitingPage ?? `${location.pathname}${location.search}` }} />;
  }
  // A super admin belongs to no station; the console is theirs (P5A design §4.1). A client belongs to none either: their
  // pages are under /client (ADR-006), which also says so when a station has taken their access away.
  const hasPlace =
    signedInUser.data.stations.length > 0 ||
    signedInUser.data.user.platformRole === 'SUPER_ADMIN' ||
    signedInUser.data.clientAccesses.length > 0 ||
    portalAreaOf(location.pathname) === 'client';
  if (!hasPlace) return <NoStationPage onSignOut={() => void signOut()} />;
  return <Outlet />;
}

/** "/" goes to the person's first station, or a client's adverts. */
export function HomeRedirect() {
  const signedInUser = useSignedInUser();
  if (!signedInUser.data) return null;
  return <Navigate to={homePathFor(signedInUser.data)} replace />;
}
