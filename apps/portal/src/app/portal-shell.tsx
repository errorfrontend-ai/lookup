import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Icon } from '../components/icons';
import { describeStationStatus } from '../plain-words/station-status-words';
import { type MemberStation, useRequiredCurrentStation } from '../features/stations/use-current-station';
import { PortalNavigation } from './portal-navigation';

/**
 * The frame around every station screen. At large widths (lg and up) the navigation is a sidebar;
 * below that it is a top bar with a Menu button that opens the same navigation as a drawer.
 */
export function PortalShell() {
  const station = useRequiredCurrentStation();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const location = useLocation();

  // Following a link closes the drawer.
  useEffect(() => setIsDrawerOpen(false), [location.pathname]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr]">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:p-2">
        Skip to content
      </a>

      <aside className="hidden border-r border-line-soft bg-surface lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:overflow-y-auto">
        <PortalNavigation station={station} />
      </aside>

      <header className="sticky top-0 z-30 flex min-h-14 items-center justify-between gap-3 border-b border-line-soft bg-surface px-4 lg:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="radio" size={22} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <span className="block font-display text-label">Look Up</span>
            <span className="block truncate text-caption text-muted">
              {station.name} · {station.frequencyLabel}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setIsDrawerOpen(true)}
          aria-expanded={isDrawerOpen}
          aria-controls="navigation-drawer"
          className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-label"
        >
          <Icon name="menu" size={20} />
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
        className="absolute inset-y-0 left-0 flex w-80 max-w-[88vw] flex-col overflow-y-auto bg-surface shadow-lg"
      >
        <div className="flex justify-end p-2">
          <button type="button" onClick={onClose} className="flex min-h-11 items-center gap-2 rounded-md px-3 text-label">
            <Icon name="close" size={18} />
            Close
          </button>
        </div>
        <PortalNavigation station={station} />
      </div>
    </div>
  );
}

function StationStatusBanner({ station }: { station: MemberStation }) {
  const banner = describeStationStatus(station.status).banner;
  if (!banner) return null;
  return (
    <p role="status" className="flex items-start gap-3 border-b border-warning bg-warning-soft px-4 py-3 text-body text-ink sm:px-6 lg:px-8">
      <Icon name="info" size={20} className="mt-0.5 shrink-0 text-warning" />
      {banner}
    </p>
  );
}
