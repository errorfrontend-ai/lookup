import type { AdSummary } from '@lookup/contracts';
import { Link } from 'react-router';
import { Button } from '../../components/button';
import { ClientAvatar } from '../../components/client-avatar';
import { ErrorNotice } from '../../components/error-notice';
import { Icon, type IconName } from '../../components/icons';
import { PageHeader } from '../../components/page-header';
import { Skeleton } from '../../components/skeleton';
import { OnAirBadge } from '../../components/status-badges';
import { describeScheduleSummary, formatDateRange, formatStationDate } from '../../formatting/describe-schedule';
import { describeAttentionReason } from '../../plain-words/ad-status-words';
import { useClients } from '../clients/use-clients';
import { useRequiredCurrentStation } from '../stations/use-current-station';
import { useStationOverview } from '../stations/use-station-overview';

function CountTile({ label, count, to, icon, isAlert = false }: { label: string; count: number; to: string; icon: IconName; isAlert?: boolean }) {
  const alertClasses = isAlert && count > 0 ? 'border-danger bg-danger-soft' : 'border-line-soft bg-surface';
  return (
    <Link to={to} className={`flex flex-col gap-2 rounded-lg border p-4 no-underline hover:border-accent ${alertClasses}`}>
      <span className="flex items-center gap-2 text-label text-muted">
        <Icon name={icon} size={18} />
        {label}
      </span>
      <span className="font-display text-display tabular-nums">{count}</span>
    </Link>
  );
}

function LiveNowRow({ ad }: { ad: AdSummary }) {
  return (
    <li className="flex items-center gap-3 rounded-md px-1 py-2">
      <ClientAvatar clientId={ad.client.id} name={ad.client.name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label">{ad.title}</span>
        <span className="text-caption text-muted">
          {ad.client.name}
          {ad.campaign ? ` · ${describeScheduleSummary(ad.campaign.timeWindows)} · ${formatDateRange(ad.campaign.startsOn, ad.campaign.endsOn)}` : ''}
        </span>
      </div>
      <OnAirBadge />
    </li>
  );
}

function AttentionRow({ ad }: { ad: AdSummary }) {
  const reason = ad.attentionReasons[0];
  if (!reason) return null;
  const words = describeAttentionReason(reason, ad.client.name, ad.campaign ? formatStationDate(ad.campaign.endsOn) : null);
  return (
    <li className="flex items-start gap-3 py-2">
      <Icon name="alert" size={18} className="mt-0.5 shrink-0 text-danger" />
      <div className="flex min-w-0 flex-col">
        <span className="text-label">{words.title}</span>
        <span className="text-caption text-muted">
          {ad.title} · {words.detail}
        </span>
      </div>
    </li>
  );
}

function GettingStarted({ stationId, hasClients }: { stationId: string; hasClients: boolean }) {
  return (
    <section aria-label="Getting started" className="flex flex-col gap-4 rounded-lg border border-line-soft bg-surface p-5">
      <h2 className="text-heading">Get your first ad on air</h2>
      <ol className="flex flex-col gap-3">
        <li className="flex items-center gap-3">
          <span className={`flex size-7 shrink-0 items-center justify-center rounded-pill text-label ${hasClients ? 'bg-success text-surface' : 'bg-ink text-surface'}`}>
            {hasClients ? <Icon name="check" size={14} /> : '1'}
          </span>
          <span className="text-body">
            <Link to={`/stations/${stationId}/clients`} className="text-accent underline underline-offset-4">
              Add a client
            </Link>{' '}
            — the business you upload ads for.
          </span>
        </li>
        <li className="flex items-center gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-pill bg-ink text-label text-surface">2</span>
          <span className="text-body">Upload their ad, add its buttons and set when it airs.</span>
        </li>
      </ol>
    </section>
  );
}

export function OverviewPage() {
  const station = useRequiredCurrentStation();
  const overview = useStationOverview(station.id, true);
  const clients = useClients(station.id);
  const adsPath = `/stations/${station.id}/ads`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview" description="What is on air, and what needs you." />

      {overview.isPending ? <Skeleton className="h-64 w-full" /> : null}
      {overview.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice error={overview.error} title="We couldn't load your overview" />
          <Button variant="secondary" onClick={() => void overview.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}

      {overview.isSuccess ? (
        <>
          <section aria-label="Your ads at a glance" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <CountTile label="On air now" count={overview.data.adCounts.live} to={`${adsPath}?view=live`} icon="radio" />
            <CountTile label="Scheduled" count={overview.data.adCounts.scheduled} to={`${adsPath}?view=scheduled`} icon="ads" />
            <CountTile label="Drafts" count={overview.data.adCounts.drafts} to={`${adsPath}?view=drafts`} icon="upload" />
            <CountTile label="Needs attention" count={overview.data.adCounts.attention} to={`${adsPath}?view=attention`} icon="alert" isAlert />
          </section>

          {overview.data.adCounts.all === 0 ? <GettingStarted stationId={station.id} hasClients={(clients.data?.length ?? 0) > 0} /> : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <section aria-label="On air now" className="flex flex-col gap-2 rounded-lg border border-line-soft bg-surface p-5">
              <h2 className="text-heading">On air now</h2>
              {overview.data.liveNowAds.length > 0 ? (
                <ul className="divide-y divide-line-soft">
                  {overview.data.liveNowAds.map((ad) => (
                    <LiveNowRow key={ad.id} ad={ad} />
                  ))}
                </ul>
              ) : (
                <p className="text-body text-muted">Nothing is on air right now.</p>
              )}
            </section>

            <section aria-label="Needs attention" className="flex flex-col gap-2 rounded-lg border border-line-soft bg-surface p-5">
              <h2 className="text-heading">Needs attention</h2>
              {overview.data.attentionAds.length > 0 ? (
                <>
                  <ul className="divide-y divide-line-soft">
                    {overview.data.attentionAds.map((ad) => (
                      <AttentionRow key={ad.id} ad={ad} />
                    ))}
                  </ul>
                  <Link to={`${adsPath}?view=attention`} className="self-start text-label text-accent underline underline-offset-4">
                    See all in Ads
                  </Link>
                </>
              ) : (
                <p className="text-body text-muted">Nothing needs your attention.</p>
              )}
            </section>
          </div>

          <section aria-label="Recognition" className="flex items-start gap-4 rounded-lg border border-line-soft bg-surface p-5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-pill bg-accent-soft text-accent">
              <Icon name="music" size={20} />
            </span>
            <div className="flex flex-col gap-1">
              <h2 className="text-heading">How listeners respond</h2>
              <p className="text-body text-muted">
                Once listeners can identify your ads in the Look Up app, you will see how many heard each one and tapped its buttons.
              </p>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
