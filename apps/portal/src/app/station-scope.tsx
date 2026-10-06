import { Link, Outlet } from 'react-router';
import { ToastProvider } from '../components/toast-region';
import { NotFoundPage } from '../components/plain-pages';
import { describeStationStatus } from '../plain-words/station-status-words';
import { canChangeStationContent, StationContext, useCurrentStation, useRequiredCurrentStation } from '../features/stations/use-current-station';

/**
 * Everything under /stations/:stationId. A station the person doesn't belong to is "not found", the
 * same answer the API gives, so ids can't be probed. Confirmation messages (toasts) live here.
 */
export function StationScope() {
  const station = useCurrentStation();
  if (!station) return <NotFoundPage />;
  return (
    <StationContext.Provider value={station}>
      <ToastProvider>
        <Outlet />
      </ToastProvider>
    </StationContext.Provider>
  );
}

/** Ads and clients exist only once the station is approved; until then this explains why. */
export function ActiveStationOnly() {
  const station = useRequiredCurrentStation();
  if (station.status === 'ACTIVE') return <Outlet />;
  const words = describeStationStatus(station.status);
  return (
    <div className="flex max-w-lg flex-col gap-4">
      <h1 className="text-display">Not available yet</h1>
      <p className="text-body text-muted">{words.banner}</p>
      <Link to={`/stations/${station.id}/profile`} className="text-label text-accent underline underline-offset-4">
        See your station's details
      </Link>
    </div>
  );
}

/**
 * The screens that change an ad's content (full-screen, outside the shell). Analysts can look at ads but
 * not change them, and a station that is not approved yet has no ads, so each is told so in plain words.
 */
export function ContentEditorsOnly() {
  const station = useRequiredCurrentStation();
  if (canChangeStationContent(station)) return <Outlet />;
  const isActive = station.status === 'ACTIVE';
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-title">{isActive ? "You can't set up ads" : 'Not available yet'}</h1>
      <p className="text-body text-muted">
        {isActive ? 'Owners and managers set up ads. You can look at every ad, but not change it.' : describeStationStatus(station.status).banner}
      </p>
      <Link to={`/stations/${station.id}/${isActive ? 'ads' : 'profile'}`} className="text-label text-accent underline underline-offset-4">
        {isActive ? 'Go to the ads' : "See your station's details"}
      </Link>
    </main>
  );
}
