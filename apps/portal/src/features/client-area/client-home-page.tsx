import type { ClientAdSummary, ClientStationSection } from '@lookup/contracts';
import { useId } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { SkeletonRows } from '../../components/skeleton';
import { CampaignStatusBadge } from '../../components/status-badges';
import { describeScheduleSummary } from '../../formatting/describe-schedule';
import { describeCampaignDates, describeHeardLastSevenDays, describeSlot, describeStation, stationToday } from '../../plain-words/client-words';
import { ClientFigureTiles, NoAdvertsToView, SpreadsheetButton, ViewOnlyNote } from './client-parts';
import { notificationPermission, pushSupport } from './this-device';
import { useClientHome } from './use-client-area';

/** The address of one advert's page. */
export const clientAdPath = (stationId: string, adId: string) => `/client/stations/${stationId}/ads/${adId}`;

function AdCard({ ad, stationId, today }: { ad: ClientAdSummary; stationId: string; today: string }) {
  return (
    <li>
      <Link to={clientAdPath(stationId, ad.id)} className="flex flex-col gap-2 rounded-lg border border-line-soft bg-surface p-4 no-underline hover:border-line">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-heading text-ink">{ad.title}</span>
          <CampaignStatusBadge status={ad.status} />
        </span>
        <span className="text-label text-muted">
          {describeScheduleSummary(ad.timeWindows)} · {describeCampaignDates(ad, today)}
        </span>
        <span className="text-label text-ink">{describeHeardLastSevenDays(ad.heardLastSevenDays)}</span>
      </Link>
    </li>
  );
}

/** One station's part of the home: its own next slot, figures and adverts, never added to another station's (P5C-DASHBOARD-02). */
function StationSection({ section }: { section: ClientStationSection }) {
  const headingId = useId();
  const today = stationToday(section.timeZone);
  const station = describeStation(section.stationName, section.frequencyLabel);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-title">
        {station}
      </h2>

      <div className="flex flex-col gap-1 rounded-lg border border-accent bg-accent-soft p-4">
        <span className="text-label text-muted">Next on air</span>
        {section.nextOnAir ? (
          <>
            <span className="font-display text-heading text-ink">{describeSlot(section.nextOnAir, today)}</span>
            <Link to={clientAdPath(section.stationId, section.nextOnAir.adId)} className="flex min-h-11 items-center self-start text-label text-accent underline">
              {section.nextOnAir.adTitle}
            </Link>
          </>
        ) : (
          <span className="text-body text-ink">Nothing scheduled in the next 14 days.</span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-heading">Last 7 days</h3>
        <ClientFigureTiles figures={section.lastSevenDays} label={`Last 7 days on ${station}`} />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-heading">{`Your ads on ${section.stationName ?? 'this station'}`}</h3>
        {section.ads.length === 0 ? (
          <p className="text-body text-muted">No adverts published yet. They appear here once the station publishes them.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {section.ads.map((ad) => (
              <AdCard key={ad.id} ad={ad} stationId={section.stationId} today={today} />
            ))}
          </ul>
        )}
      </div>

      <SpreadsheetButton stationId={section.stationId} stationName={section.stationName} />
      <ViewOnlyNote stationName={section.stationName} contact={section.contact} what="an ad" />
    </section>
  );
}

/**
 * The first visit's offer (P5C-NOTIFY-02): reminders before each slot, set up on the Notifications page. Shown while this
 * browser has never been asked, or on an iPhone not yet on the Home Screen; never asks for permission by itself.
 */
function RemindersCard() {
  const support = pushSupport();
  const isNeverAsked = support === 'SUPPORTED' && notificationPermission() === 'default';
  if (!isNeverAsked && support !== 'NEEDS_HOME_SCREEN') return null;
  return (
    <section aria-labelledby="client-reminders-card" className="flex flex-col items-start gap-2 rounded-lg border border-line-soft bg-surface p-4">
      <h2 id="client-reminders-card" className="text-heading">
        Get a notification before your adverts air
      </h2>
      <p className="text-body text-muted">A reminder before each time slot, so you can listen in and check.</p>
      <Link to="/client/notifications" className="flex min-h-11 items-center text-label text-accent underline underline-offset-4">
        Set up reminders
      </Link>
    </section>
  );
}

/**
 * A client's home (ADR-006 decision 4; P5C-DASHBOARD-02, -07, -08): every station that gave access, each its own section
 * with its next slot, the last 7 days and the adverts. Nothing adds stations together.
 */
export function ClientHomePage() {
  const home = useClientHome();
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-display">Your adverts</h1>
      {home.isSuccess && home.data.stations.length > 0 ? <RemindersCard /> : null}
      {home.isPending ? <SkeletonRows count={3} rowClassName="h-28" /> : null}
      {home.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice error={home.error} title="We couldn't load your adverts" />
          <Button variant="secondary" onClick={() => void home.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      {home.isSuccess && home.data.stations.length === 0 ? <NoAdvertsToView /> : null}
      {home.isSuccess
        ? home.data.stations.map((section) => (
            <div key={section.stationId} className="border-t border-line-soft pt-6 first-of-type:border-t-0 first-of-type:pt-0">
              <StationSection section={section} />
            </div>
          ))
        : null}
    </div>
  );
}
