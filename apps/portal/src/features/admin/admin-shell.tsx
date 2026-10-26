import type { AdminSummary } from '@lookup/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { portalApi } from '../../app/portal-api';
import { Icon } from '../../components/icons';
import { NotFoundPage } from '../../components/plain-pages';
import { useFocusHeadingOnChange } from '../../components/use-focus-heading-on-change';
import { useSignOut } from '../session/use-sign-out';
import { useSignedInUser } from '../session/use-signed-in-user';
import { homePathFor } from '../sign-in/sign-in-page';

export const ADMIN_SUMMARY_QUERY_KEY = ['admin', 'summary'] as const;

/** Only a super admin past the second factor sees the console; anyone else is told there is no such page. */
export function RequireSuperAdmin() {
  const signedInUser = useSignedInUser();
  const location = useLocation();
  const user = signedInUser.data;
  if (!user) return <NotFoundPage />;
  // Anyone else is sent to their own pages: nothing here says the console exists (the API answers 404 too).
  if (user.user.platformRole !== 'SUPER_ADMIN') return <Navigate to={homePathFor(user)} replace />;
  // The page asked for waits through the second factor.
  if (user.isTwoFactorCodeNeeded) return <Navigate to="/two-factor" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

const NAVIGATION: Array<{ to: string; label: string; badge?: keyof AdminSummary }> = [
  { to: '/admin/applications', label: 'Applications', badge: 'waitingApplicationCount' },
  { to: '/admin/stations', label: 'Stations' },
  { to: '/admin/audio-to-check', label: 'Audio to check', badge: 'audioToCheckCount' },
  { to: '/admin/system-health', label: 'System health' },
  { to: '/admin/reference-codes', label: 'Find by reference code' },
];

function AdminNavigation() {
  const signedInUser = useSignedInUser();
  const signOut = useSignOut();
  const summary = useQuery({
    queryKey: ADMIN_SUMMARY_QUERY_KEY,
    queryFn: () => portalApi.get<AdminSummary>('/admin/summary'),
    refetchInterval: 60_000,
  });
  return (
    <nav aria-label="Console" className="flex flex-1 flex-col gap-4 p-4">
      <div className="flex flex-col">
        <span className="font-display text-title">Look Up</span>
        <span className="text-caption text-muted">Super admin</span>
      </div>
      <ul className="flex flex-col gap-1">
        {NAVIGATION.map((item) => {
          const count = item.badge ? summary.data?.[item.badge] : undefined;
          return (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  `flex min-h-11 items-center justify-between gap-2 rounded-md px-3 text-label ${isActive ? 'bg-accent-soft text-ink' : 'hover:bg-ground'}`
                }
              >
                {item.label}
                {/* A space, so the name reads "Applications 2 waiting" (a flex layout draws no gap for it). */}
                {count ? ' ' : null}
                {count ? (
                  <span className="rounded-pill bg-accent px-2 text-caption text-on-accent">
                    <span aria-hidden="true">{count}</span>
                    <span className="sr-only">{`${count} waiting`}</span>
                  </span>
                ) : null}
              </NavLink>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto flex flex-col gap-2 border-t border-line-soft pt-4">
        <span className="text-body">{signedInUser.data?.user.fullName}</span>
        <button type="button" onClick={() => void signOut()} className="min-h-11 self-start rounded-md px-3 text-label hover:bg-ground">
          Sign out
        </button>
      </div>
    </nav>
  );
}

/** The console's frame (P5A design §4.4): a sidebar from lg; below it, a top bar with a menu that opens a drawer. */
export function AdminShell() {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const location = useLocation();
  const drawer = useRef<HTMLDivElement>(null);
  useEffect(() => setIsDrawerOpen(false), [location.pathname]);
  useFocusHeadingOnChange(location.pathname);
  useEffect(() => {
    if (!isDrawerOpen) return undefined;
    drawer.current?.querySelector<HTMLElement>('a, button')?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsDrawerOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [isDrawerOpen]);

  return (
    <div className="min-h-dvh bg-ground lg:grid lg:grid-cols-[15.5rem_1fr]">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:p-2">
        Skip to content
      </a>
      <aside className="hidden border-r border-line-soft bg-surface lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <AdminNavigation />
      </aside>
      <header className="sticky top-0 z-30 flex min-h-14 items-center justify-between gap-3 border-b border-line-soft bg-surface px-4 lg:hidden">
        <span className="font-display text-label">Look Up · Super admin</span>
        <button
          type="button"
          onClick={() => setIsDrawerOpen(true)}
          aria-expanded={isDrawerOpen}
          aria-controls="admin-drawer"
          className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-label"
        >
          <Icon name="menu" size={20} />
          Menu
        </button>
      </header>
      {isDrawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" aria-hidden="true" onClick={() => setIsDrawerOpen(false)} />
          <div id="admin-drawer" ref={drawer} role="dialog" aria-modal="true" aria-label="Menu" className="absolute inset-y-0 left-0 flex w-80 max-w-[88vw] flex-col overflow-y-auto bg-surface shadow-lg">
            <div className="flex justify-end p-2">
              <button type="button" onClick={() => setIsDrawerOpen(false)} className="flex min-h-11 items-center gap-2 rounded-md px-3 text-label">
                <Icon name="close" size={18} />
                Close
              </button>
            </div>
            <AdminNavigation />
          </div>
        </div>
      ) : null}
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
