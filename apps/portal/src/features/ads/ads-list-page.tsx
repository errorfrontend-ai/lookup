import { AD_LIST_VIEWS, type AdListView } from '@lookup/contracts';
import { type ChangeEvent, useEffect, useState } from 'react';
import { Button } from '../../components/button';
import { EmptyState } from '../../components/empty-state';
import { ErrorNotice } from '../../components/error-notice';
import { Icon } from '../../components/icons';
import { type LinkTab, LinkTabs } from '../../components/link-tabs';
import { PageHeader } from '../../components/page-header';
import { SkeletonRows } from '../../components/skeleton';
import { useMediaQuery, WIDE_SCREEN_QUERY } from '../../components/use-media-query';
import { useClients } from '../clients/use-clients';
import { canChangeStationContent, useRequiredCurrentStation } from '../stations/use-current-station';
import { useStationOverview } from '../stations/use-station-overview';
import { type AdListFilters, adListSearchParams, useAdListFilters } from './ad-list-filters';
import { AdCards, AdTable } from './ad-list-items';
import { useAdList } from './use-ad-list';

const TAB_LABELS: Record<AdListView, string> = {
  all: 'All',
  live: 'Live now',
  scheduled: 'Scheduled',
  drafts: 'Drafts',
  attention: 'Needs attention',
  ended: 'Ended',
};

const SORT_LABELS = { updated: 'Last changed', startDate: 'Newest start', title: 'A to Z' } as const;
const SEARCH_PAUSE_MILLISECONDS = 300;

/** What an empty tab says, so an empty list is never a blank page. */
const EMPTY_TAB_MESSAGES: Record<AdListView, string> = {
  all: 'No ads yet.',
  live: 'Nothing is on air right now.',
  scheduled: 'Nothing is scheduled.',
  drafts: 'No drafts.',
  attention: 'Nothing needs your attention.',
  ended: 'No ads have ended yet.',
};

const FILTER_CONTROL_CLASSES = 'min-h-11 rounded-md border border-line bg-surface px-3 text-label text-ink';

function useSearchBox(filters: AdListFilters, changeSearch: (search: string | undefined) => void) {
  const [searchText, setSearchText] = useState(filters.search ?? '');
  // Another change to the address (Clear filters, the back button) shows in the box.
  useEffect(() => setSearchText(filters.search ?? ''), [filters.search]);
  // Typing waits for a short pause before it asks the server.
  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed === (filters.search ?? '')) return undefined;
    const timer = setTimeout(() => changeSearch(trimmed || undefined), SEARCH_PAUSE_MILLISECONDS);
    return () => clearTimeout(timer);
  }, [searchText, filters.search, changeSearch]);
  return { searchText, setSearchText };
}

export function AdsListPage() {
  const station = useRequiredCurrentStation();
  const { filters, changeFilters } = useAdListFilters();
  const ads = useAdList(station.id, filters);
  const overview = useStationOverview(station.id, true);
  const clients = useClients(station.id);
  const isWideScreen = useMediaQuery(WIDE_SCREEN_QUERY);
  const canChange = canChangeStationContent(station);
  const { searchText, setSearchText } = useSearchBox(filters, (search) => changeFilters({ search }, { replace: true }));

  const tabs: LinkTab[] = AD_LIST_VIEWS.map((view) => ({
    id: view,
    label: TAB_LABELS[view],
    to: `?${adListSearchParams({ ...filters, view }).toString()}`,
    isCurrent: filters.view === view,
    alertCount: view === 'attention' ? overview.data?.adCounts.attention : undefined,
  }));

  const loadedAds = ads.data?.pages.flatMap((page) => page.ads) ?? [];
  const isFiltered = Boolean(filters.search || filters.clientId);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Ads" description="Upload ads for your clients, add their buttons and set when each one airs." />

      <LinkTabs label="Ad status" tabs={tabs} />

      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <label className="relative flex-1 md:max-w-sm">
          <span className="sr-only">Search title or client</span>
          <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={searchText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setSearchText(event.target.value)}
            placeholder="Search title or client"
            maxLength={80}
            className={`${FILTER_CONTROL_CLASSES} w-full pl-10 placeholder:text-muted`}
          />
        </label>
        <div className="grid grid-cols-2 gap-2 md:ml-auto md:flex">
          <label>
            <span className="sr-only">Client</span>
            <select
              value={filters.clientId ?? ''}
              onChange={(event) => changeFilters({ clientId: event.target.value || undefined })}
              className={`${FILTER_CONTROL_CLASSES} w-full`}
            >
              <option value="">All clients</option>
              {(clients.data ?? []).map((clientItem) => (
                <option key={clientItem.id} value={clientItem.id}>
                  {clientItem.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Sort by</span>
            <select
              value={filters.sort}
              onChange={(event) => changeFilters({ sort: event.target.value as AdListFilters['sort'] })}
              className={`${FILTER_CONTROL_CLASSES} w-full`}
            >
              {Object.entries(SORT_LABELS).map(([sort, label]) => (
                <option key={sort} value={sort}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {ads.isPending ? <SkeletonRows count={5} /> : null}
      {ads.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice error={ads.error} title="We couldn't load your ads" />
          <Button variant="secondary" onClick={() => void ads.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}

      {ads.isSuccess && loadedAds.length === 0 ? (
        isFiltered ? (
          <EmptyState
            icon="search"
            title="No ads match"
            action={
              <Button variant="secondary" onClick={() => changeFilters({ search: undefined, clientId: undefined })}>
                Clear search and client
              </Button>
            }
          >
            Nothing{filters.search ? ` matches “${filters.search}”` : ''} here. Try a different word, client or tab.
          </EmptyState>
        ) : (
          <EmptyState icon="ads" title={EMPTY_TAB_MESSAGES[filters.view]}>
            {filters.view === 'all'
              ? canChange
                ? 'Ads you upload for your clients appear here, with their buttons and schedule.'
                : 'Ads appear here once an owner or manager uploads them.'
              : 'Ads that fit this tab will show up here on their own.'}
          </EmptyState>
        )
      ) : null}

      {ads.isSuccess && loadedAds.length > 0 ? (
        <>
          {isWideScreen ? <AdTable ads={loadedAds} stationId={station.id} /> : <AdCards ads={loadedAds} stationId={station.id} />}
          <div className="flex flex-col items-center gap-3 text-label text-muted">
            <span>{loadedAds.length === 1 ? 'Showing 1 ad' : `Showing ${loadedAds.length} ads`}</span>
            {ads.hasNextPage ? (
              <Button variant="secondary" isBusy={ads.isFetchingNextPage} busyLabel="Loading…" onClick={() => void ads.fetchNextPage()}>
                Show 20 more
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
