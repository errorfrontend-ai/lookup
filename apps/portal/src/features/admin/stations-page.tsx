import { type AdminStationList, type AdminStationListItem, MINIMUM_DECISION_REASON_LENGTH } from '@lookup/contracts';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { portalApi } from '../../app/portal-api';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { ModalDialog } from '../../components/modal-dialog';
import { TextAreaField } from '../../components/text-area-field';
import { TextField } from '../../components/text-field';
import { ageWords, STATION_STATUS_WORDS } from './admin-words';

const STATIONS_QUERY_KEY = ['admin', 'stations'] as const;

/**
 * Stations (P5A design §4.4; journey G): every station, found by part of its name, frequency or town, 25 at a time;
 * "Suspend" asks for a reason and warns that the ads stop at once; "Reactivate" brings them back.
 */
export function StationsPage() {
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [suspending, setSuspending] = useState<AdminStationListItem | null>(null);
  const stations = useInfiniteQuery({
    queryKey: [...STATIONS_QUERY_KEY, search],
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams();
      if (search) query.set('search', search);
      if (pageParam) query.set('cursor', pageParam);
      const text = query.toString();
      return portalApi.get<AdminStationList>(`/admin/stations${text ? `?${text}` : ''}`);
    },
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const reactivate = useMutation({
    mutationFn: (stationId: string) => portalApi.post<void>(`/admin/stations/${stationId}/reactivation`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STATIONS_QUERY_KEY }),
  });
  const rows = stations.data?.pages.flatMap((page) => page.stations) ?? [];

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(typed.trim());
  };

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-display">Stations</h1>
      <form role="search" onSubmit={submitSearch} className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <TextField label="Search by name, frequency or town" type="search" maxLength={80} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {stations.isError ? <ErrorNotice error={stations.error} title="We couldn't load the stations" /> : null}
      {reactivate.isError ? <ErrorNotice error={reactivate.error} /> : null}
      <ul className="flex flex-col gap-2">
        {stations.isPending ? <li className="text-body text-muted">Loading…</li> : null}
        {stations.isSuccess && rows.length === 0 ? <li className="text-body text-muted">No station matches.</li> : null}
        {rows.map((station) => (
          <li key={station.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface p-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-label">
                {station.name ?? 'Still signing up'} · {station.frequencyLabel ?? '—'}
              </span>
              <span className="text-caption text-muted">
                {[station.city, station.province].filter(Boolean).join(', ') || 'Town not given'} · {station.memberCount} {station.memberCount === 1 ? 'member' : 'members'}
                {station.lastDecisionAt ? ` · last decision ${ageWords(station.lastDecisionAt)}` : ''}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-pill bg-ground px-3 py-1 text-caption font-bold">{STATION_STATUS_WORDS[station.status]}</span>
              {station.status === 'ACTIVE' ? (
                <Button variant="danger" onClick={() => setSuspending(station)}>
                  Suspend
                </Button>
              ) : null}
              {station.status === 'SUSPENDED' ? (
                <Button variant="secondary" onClick={() => reactivate.mutate(station.id)} isBusy={reactivate.isPending && reactivate.variables === station.id} busyLabel="Reactivating…">
                  Reactivate
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {stations.hasNextPage ? (
        <Button variant="secondary" className="self-start" onClick={() => void stations.fetchNextPage()} isBusy={stations.isFetchingNextPage} busyLabel="Loading…">
          Show 25 more
        </Button>
      ) : null}
      {suspending ? <SuspendDialog station={suspending} onClose={() => setSuspending(null)} /> : null}
    </div>
  );
}

function SuspendDialog({ station, onClose }: { station: AdminStationListItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const suspend = useMutation({
    mutationFn: () => portalApi.post<void>(`/admin/stations/${station.id}/suspension`, { reason: reason.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: STATIONS_QUERY_KEY });
      onClose();
    },
  });
  return (
    <ModalDialog title={`Suspend ${station.name ?? 'this station'}?`} onClose={onClose}>
      <p className="text-body">Its ads stop reaching listeners straight away. The station gets an SMS and email with your reason.</p>
      <TextAreaField label="Reason (the station sees this)" maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
      {suspend.isError ? <ErrorNotice error={suspend.error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={reason.trim().length < MINIMUM_DECISION_REASON_LENGTH} isBusy={suspend.isPending} busyLabel="Suspending…" onClick={() => suspend.mutate()}>
          Suspend station
        </Button>
      </div>
    </ModalDialog>
  );
}
