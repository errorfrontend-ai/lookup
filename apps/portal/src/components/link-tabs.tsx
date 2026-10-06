import { Link } from 'react-router';

export interface LinkTab {
  id: string;
  label: string;
  to: string;
  isCurrent: boolean;
  /** A count shown in a red badge: only for things that need attention. */
  alertCount?: number;
}

/**
 * Tabs that are links, because choosing one changes the address (so back, refresh and sharing keep the
 * view). Underlined tabs from md up; scrollable chips on a phone.
 */
export function LinkTabs({ label, tabs }: { label: string; tabs: LinkTab[] }) {
  return (
    <nav aria-label={label} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:gap-1 md:border-b md:border-line md:px-0 md:pb-0">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          to={tab.to}
          aria-current={tab.isCurrent ? 'page' : undefined}
          className={[
            'flex min-h-11 shrink-0 items-center gap-2 rounded-pill border px-3.5 text-label no-underline',
            'md:-mb-px md:rounded-none md:border-0 md:border-b-[3px] md:px-3.5',
            tab.isCurrent
              ? 'border-ink bg-ink text-surface md:border-accent md:bg-transparent md:text-ink'
              : 'border-line bg-surface text-ink md:border-transparent md:bg-transparent md:text-muted md:hover:text-ink',
          ].join(' ')}
        >
          {tab.label}
          {tab.alertCount ? (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-pill bg-danger px-1.5 text-caption text-surface">
              <span className="sr-only">{tab.alertCount} need attention, </span>
              <span aria-hidden="true">{tab.alertCount}</span>
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
