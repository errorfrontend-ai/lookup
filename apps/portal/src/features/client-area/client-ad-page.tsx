import { type ClientAdFigures, LISTENER_FIGURES_RANGES, type ListenerFiguresRange } from '@lookup/contracts';
import { useEffect, useId, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { Icon } from '../../components/icons';
import { ListenerCardPreview } from '../../components/listener-card-preview';
import { Skeleton, SkeletonRows } from '../../components/skeleton';
import { CampaignStatusBadge } from '../../components/status-badges';
import { describeTimeWindow, formatDateRange } from '../../formatting/describe-schedule';
import { describeCampaignDates, describeSlot, describeStation, stationToday } from '../../plain-words/client-words';
import { ListenerMixPanel } from '../overview/listener-mix-section';
import { ClientFigureTiles, TAP_KINDS, ViewOnlyNote } from './client-parts';
import { useClientAd, useClientAdFigures, useClientListenerMix } from './use-client-area';

const RANGE_CHOICES: Record<ListenerFiguresRange, string> = { today: 'Today', last7Days: 'Last 7 days', last30Days: 'Last 30 days' };

function RangeChoice({ label, range, onChange }: { label: string; range: ListenerFiguresRange; onChange: (range: ListenerFiguresRange) => void }) {
  return (
    <label className="flex flex-col">
      <span className="sr-only">{label}</span>
      <select value={range} onChange={(event) => onChange(event.target.value as ListenerFiguresRange)} className="min-h-11 rounded-md border border-line bg-surface px-3 text-label text-ink">
        {LISTENER_FIGURES_RANGES.map((choice) => (
          <option key={choice} value={choice}>
            {RANGE_CHOICES[choice]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Taps by button type: bars for the eye (hidden from screen readers), the counts as text, and the same as a table. */
function TapsByButton({ figures }: { figures: ClientAdFigures }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const highest = Math.max(1, ...TAP_KINDS.map((kind) => figures[kind.key]));
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-heading">Taps by button</h3>
        <div role="group" aria-label="Show taps as" className="flex rounded-md border border-line">
          {(['chart', 'table'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={view === choice}
              onClick={() => setView(choice)}
              className={`min-h-11 px-4 text-label first:rounded-l-md last:rounded-r-md ${view === choice ? 'bg-ink text-surface' : 'bg-surface text-ink hover:bg-ground'}`}
            >
              {choice === 'chart' ? 'Chart' : 'Table'}
            </button>
          ))}
        </div>
      </div>
      {view === 'chart' ? (
        <ul aria-label="Taps by button" className="flex flex-col gap-2">
          {TAP_KINDS.map((kind) => (
            <li key={kind.key} className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_3rem] items-center gap-2 text-label">
              <span className="truncate">{kind.title}</span>
              <span aria-hidden="true" className="h-3 rounded-sm bg-ground">
                <span className="block h-3 rounded-sm bg-accent" style={{ width: `${(figures[kind.key] / highest) * 100}%` }} />
              </span>
              <span className="text-right tabular-nums">{figures[kind.key].toLocaleString('en-US')}</span>
            </li>
          ))}
        </ul>
      ) : (
        <table className="w-full text-left text-label">
          <caption className="sr-only">Taps by button</caption>
          <thead>
            <tr className="text-muted">
              <th scope="col" className="py-1">
                Button
              </th>
              <th scope="col" className="py-1 text-right">
                Taps
              </th>
            </tr>
          </thead>
          <tbody>
            {TAP_KINDS.map((kind) => (
              <tr key={kind.key} className="border-t border-line-soft">
                <th scope="row" className="py-1 font-normal">
                  {kind.title}
                </th>
                <td className="py-1 text-right tabular-nums">{figures[kind.key].toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** What listeners did with the advert (P5C-DASHBOARD-09, P5C-ADVERT-02), for today, 7 or 30 days. */
function WhatListenersDid({ stationId, adId }: { stationId: string; adId: string }) {
  const headingId = useId();
  const [range, setRange] = useState<ListenerFiguresRange>('last7Days');
  const figures = useClientAdFigures(stationId, adId, range);
  const shownRange = figures.data?.range ?? range;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col">
          <h2 id={headingId} className="text-heading">
            What listeners did
          </h2>
          <span className="text-caption text-muted">{`${RANGE_CHOICES[shownRange]} · in the Look Up app`}</span>
        </div>
        <RangeChoice label="Dates for what listeners did" range={range} onChange={setRange} />
      </div>
      {figures.isPending ? <Skeleton className="h-28 w-full" /> : null}
      {figures.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice error={figures.error} title="We couldn't load what listeners did" />
          <Button variant="secondary" onClick={() => void figures.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      {figures.data ? (
        <>
          <ClientFigureTiles figures={figures.data} label={`What listeners did, ${RANGE_CHOICES[shownRange].toLowerCase()}`} />
          <TapsByButton figures={figures.data} />
        </>
      ) : null}
    </section>
  );
}

function WhoIsListening({ stationId, adId }: { stationId: string; adId: string }) {
  const [range, setRange] = useState<ListenerFiguresRange>('last30Days');
  const mix = useClientListenerMix(stationId, adId, range);
  return <ListenerMixPanel mix={mix} whose="this ad" range={range} onRangeChange={setRange} />;
}

/** An advert this person can't view, or one that no longer exists: the same words for both, so nothing can be probed. */
export function ClientNotFound() {
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-display">We couldn't find that advert</h1>
      <p className="text-body text-muted">It may have ended long ago, or the station no longer shares it with you.</p>
      <Link to="/client" className="flex min-h-11 items-center text-label text-accent underline underline-offset-4">
        See all your adverts
      </Link>
    </div>
  );
}

/**
 * One advert as its client sees it (ADR-006; P5C-ADVERT-01 to -04, P5C-DASHBOARD-09): its status and dates, when it airs
 * and the next 5 times, what listeners did, who is listening, the card listeners see, and who to ask for a change.
 */
export function ClientAdPage() {
  const { stationId = '', adId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const ad = useClientAd(stationId, adId);
  // Just signed in on a page left open by someone else (another client's advert): their own adverts instead. The mark
  // counts once: when the advert loads it leaves this entry, so a reload or a later answer explains itself as usual.
  const isJustSignedIn = (location.state as { afterSignIn?: unknown } | null)?.afterSignIn === true;
  useEffect(() => {
    if (isJustSignedIn && ad.isSuccess) void navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }, [isJustSignedIn, ad.isSuccess, location.pathname, location.search, navigate]);

  if (ad.isPending) return <SkeletonRows count={4} rowClassName="h-24" />;
  if (ad.isError) {
    if (ad.error instanceof ApiError && ad.error.code === 'NOT_FOUND') return isJustSignedIn ? <Navigate to="/client" replace /> : <ClientNotFound />;
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="text-display">This advert</h1>
        <ErrorNotice error={ad.error} title="We couldn't load this advert" />
        <Button variant="secondary" onClick={() => void ad.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  const detail = ad.data;
  const today = stationToday(detail.station.timeZone);
  const station = describeStation(detail.station.name, detail.station.frequencyLabel);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <Link to="/client" className="flex min-h-11 items-center gap-1 self-start text-label text-accent">
          <Icon name="back" size={18} />
          All your adverts
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-display">{detail.title}</h1>
          <CampaignStatusBadge status={detail.status} />
        </div>
        <p className="text-body text-muted">
          {detail.clientName} · {station}
        </p>
      </header>

      <section aria-labelledby="client-ad-schedule" className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-lg border border-line-soft bg-surface p-5">
          <h2 id="client-ad-schedule" className="text-heading">
            When it airs
          </h2>
          <p className="text-body">
            {formatDateRange(detail.startsOn, detail.endsOn)} · {describeCampaignDates(detail, today)}
          </p>
          <ul className="flex flex-col gap-1 text-body">
            {detail.timeWindows.map((window) => (
              <li key={`${window.daysOfWeek.join()}-${window.localStartTime}-${window.localEndTime}`}>{describeTimeWindow(window)}</li>
            ))}
          </ul>
          <p className="text-caption text-muted">{`Times are ${detail.station.name ?? 'the station'}'s own (${detail.station.timeZone}).`}</p>
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-line-soft bg-surface p-5">
          <h2 className="text-heading">Next times on air</h2>
          {detail.nextTimesOnAir.length === 0 ? (
            <p className="text-body text-muted">
              {detail.status === 'PAUSED' ? 'This advert is paused, so it is not on air for now.' : 'No times on air in the next 14 days.'}
            </p>
          ) : (
            <ol className="flex flex-col gap-1 text-body">
              {detail.nextTimesOnAir.map((slot) => (
                <li key={slot.startsAt}>{describeSlot(slot, today)}</li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <WhatListenersDid stationId={stationId} adId={adId} />
      <WhoIsListening stationId={stationId} adId={adId} />

      <section aria-labelledby="client-ad-card" className="flex flex-col gap-3">
        <h2 id="client-ad-card" className="text-heading">
          What listeners see
        </h2>
        <ListenerCardPreview card={detail.actionCard} adTitle={detail.title} clientName={detail.clientName} stationName={detail.station.name ?? ''} frequencyLabel={detail.station.frequencyLabel ?? ''} />
      </section>

      <ViewOnlyNote stationName={detail.station.name} contact={detail.station.contact} what="this ad" />
    </div>
  );
}
