import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { NotFoundPage } from '../components/plain-pages';
import { useSignOut } from '../features/session/use-sign-out';
import { useSignedInUser } from '../features/session/use-signed-in-user';
import { canChangeStationContent, type MemberStation, useCurrentStation } from '../features/stations/use-current-station';

/**
 * The frame around every station screen. At large widths (lg and up) the navigation is a sidebar;
 * below that it is a top bar with a Menu button that opens the same navigation as a drawer.
 */
export function PortalShell() {
  const station = useCurrentStation();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const location = useLocation();

  // Following a link closes the drawer.
  useEffect(() => setIsDrawerOpen(false), [location.pathname]);

  if (!station) return <NotFoundPage />;

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:p-2">
        Skip to content
      </a>

      <aside className="hidden border-r border-line bg-surface lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <PortalNavigation station={station} />
      </aside>

      <header className="sticky top-0 z-30 flex min-h-14 items-center justify-between gap-3 border-b border-line bg-surface px-4 lg:hidden">
        <div className="min-w-0">
          <span className="block font-display text-label">Look Up</span>
          <span className="block truncate text-caption text-muted">
            {station.name} · {station.frequencyLabel}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setIsDrawerOpen(true)}
          aria-expanded={isDrawerOpen}
          aria-controls="navigation-drawer"
          className="min-h-11 rounded-md border border-line px-4 text-label"
        >
          Menu
        </button>
      </header>

      {isDrawerOpen ? <NavigationDrawer station={station} onClose={() => setIsDrawerOpen(false)} /> : null}

      <div className="flex min-w-0 flex-col">
        <StationStatusBanner station={station} />
        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function NavigationDrawer({ station, onClose }: { station: MemberStation; onClose: () => void }) {
  const drawerReference = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    drawerReference.current?.querySelector<HTMLElement>('a, button, select')?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div className="absolute inset-0 bg-ink/40" aria-hidden="true" onClick={onClose} />
      <div
        id="navigation-drawer"
        ref={drawerReference}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-surface shadow-lg"
      >
        <div className="flex justify-end p-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-md px-4 text-label">
            Close
          </button>
        </div>
        <PortalNavigation station={station} />
      </div>
    </div>
  );
}

function PortalNavigation({ station }: { station: MemberStation }) {
  const signedInUser = useSignedInUser();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const stations = signedInUser.data?.stations ?? [];
  const stationPath = `/stations/${station.id}`;

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-11 items-center rounded-md px-3 text-label ${isActive ? 'bg-accent-soft text-accent' : 'hover:bg-ground'}`;

  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-6 px-4 pb-4 lg:pt-6">
      <span className="hidden font-display text-title lg:block">Look Up</span>

      {stations.length > 1 ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-caption text-muted">Station</span>
          <select
            value={station.id}
            onChange={(event) => void navigate(`/stations/${event.target.value}/ads`)}
            className="min-h-11 rounded-md border border-line bg-surface px-2 text-body"
          >
            {stations.map((memberStation) => (
              <option key={memberStation.id} value={memberStation.id}>
                {memberStation.name} · {memberStation.frequencyLabel}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="flex flex-col">
          <span className="text-caption text-muted">Station</span>
          <span className="text-label">{station.name}</span>
          <span className="text-caption text-muted">{station.frequencyLabel}</span>
        </div>
      )}

      <ul className="flex flex-col gap-1">
        <li>
          <NavLink to={`${stationPath}/ads`} end className={linkClass}>
            Ads
          </NavLink>
        </li>
        {canChangeStationContent(station) ? (
          <li>
            <NavLink to={`${stationPath}/ads/new`} className={linkClass}>
              New ad
            </NavLink>
          </li>
        ) : null}
        <li>
          <NavLink to={`${stationPath}/account`} className={linkClass}>
            Your account
          </NavLink>
        </li>
      </ul>

      <div className="mt-auto flex flex-col gap-2 border-t border-line pt-4">
        {signedInUser.data ? <span className="truncate text-caption text-muted">{signedInUser.data.user.fullName}</span> : null}
        <button type="button" onClick={() => void signOut()} className="min-h-11 rounded-md border border-line px-3 text-left text-label">
          Sign out
        </button>
      </div>
    </nav>
  );
}

const STATUS_EXPLANATIONS: Partial<Record<MemberStation['status'], string>> = {
  PENDING_VERIFICATION: "This station hasn't finished signing up yet, so ads can't be added.",
  PENDING_REVIEW: "Look Up is checking this station's licence. You'll be able to add ads once it's approved.",
  REJECTED: "This station's application wasn't approved, so ads can't be added.",
  SUSPENDED: "This station is suspended. Listeners can't see its ads. Contact Look Up support for help.",
};

function StationStatusBanner({ station }: { station: MemberStation }) {
  const explanation = STATUS_EXPLANATIONS[station.status];
  if (!explanation) return null;
  return (
    <p role="status" className="border-b border-warning bg-warning-soft px-4 py-3 text-body text-ink sm:px-6 lg:px-8">
      {explanation}
    </p>
  );
}
