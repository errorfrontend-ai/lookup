import type { SignedInPortalUser } from '@lookup/contracts';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Icon } from '../../components/icons';
import { useFocusHeadingOnChange } from '../../components/use-focus-heading-on-change';
import { useSignOut } from '../session/use-sign-out';
import { useSignedInUser } from '../session/use-signed-in-user';

/** The places in the client's area, in the order the menu lists them. */
export const CLIENT_MENU_ITEMS = [
  { path: '/client', label: 'Home', isEnd: true },
  { path: '/client/account', label: 'Account', isEnd: false },
] as const;

/** Whose adverts these are: the client's name, or the person's own name when they follow several clients. */
export function clientAreaTitle(signedInUser: SignedInPortalUser | null | undefined): string {
  const clientNames = [...new Set((signedInUser?.clientAccesses ?? []).map((access) => access.clientName))];
  if (clientNames.length === 1) return clientNames[0] as string;
  return signedInUser?.user.fullName ?? 'Your adverts';
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'flex min-h-11 items-center rounded-md px-3 text-label no-underline',
    isActive ? 'bg-accent-soft font-bold text-accent' : 'text-ink hover:bg-ground',
  ].join(' ');

/**
 * The frame around a client's pages (ADR-006; P5C-DASHBOARD-05): "Look Up", whose adverts these are, and a menu with Home,
 * Account and Sign out. On a phone the menu folds behind a Menu button; from 768 px it sits in the header.
 */
export function ClientShell() {
  const signedInUser = useSignedInUser();
  const signOut = useSignOut();
  const location = useLocation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  useEffect(() => setIsMenuOpen(false), [location.pathname]);
  useFocusHeadingOnChange(location.pathname);

  const menu = (
    <>
      {CLIENT_MENU_ITEMS.map((item) => (
        <NavLink key={item.path} to={item.path} end={item.isEnd} className={linkClass}>
          {item.label}
        </NavLink>
      ))}
      <button type="button" onClick={() => void signOut()} className="flex min-h-11 items-center rounded-md px-3 text-left text-label text-ink hover:bg-ground">
        Sign out
      </button>
    </>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:p-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line-soft bg-surface">
        <div className="mx-auto flex min-h-14 w-full max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="radio" size={22} className="shrink-0 text-accent" />
            <div className="min-w-0">
              <span className="block font-display text-label">Look Up</span>
              <span className="block truncate text-caption text-muted">{clientAreaTitle(signedInUser.data)}</span>
            </div>
          </div>
          <nav aria-label="Client menu" className="hidden items-center gap-1 md:flex">
            {menu}
          </nav>
          <button
            type="button"
            onClick={() => setIsMenuOpen((isOpen) => !isOpen)}
            aria-expanded={isMenuOpen}
            aria-controls="client-menu"
            className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-label md:hidden"
          >
            <Icon name={isMenuOpen ? 'close' : 'menu'} size={20} />
            Menu
          </button>
        </div>
        {isMenuOpen ? (
          <nav id="client-menu" aria-label="Menu" className="flex flex-col gap-1 border-t border-line-soft px-4 py-2 md:hidden">
            {menu}
          </nav>
        ) : null}
      </header>
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
