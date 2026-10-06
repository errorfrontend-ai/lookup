import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ClientAvatar } from '../../components/client-avatar';
import { ErrorNotice } from '../../components/error-notice';
import { Icon } from '../../components/icons';
import { type LinkTab, LinkTabs } from '../../components/link-tabs';
import { PageHeader } from '../../components/page-header';
import { Skeleton } from '../../components/skeleton';
import { CampaignStatusBadge, FileStatusBadge } from '../../components/status-badges';
import { canChangeStationContent, useRequiredCurrentStation } from '../stations/use-current-station';
import { AdButtonsTab } from './detail/ad-buttons-tab';
import { RemoveAdDialog, RenameAdDialog } from './detail/ad-detail-actions';
import { AdHistoryTab } from './detail/ad-history-tab';
import { AdOverviewTab } from './detail/ad-overview-tab';
import { AdScheduleTab } from './detail/ad-schedule-tab';
import { useAd } from './use-ad-detail';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'buttons', label: 'Buttons' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'history', label: 'History' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function AdNotFound({ stationId }: { stationId: string }) {
  return (
    <div className="flex max-w-lg flex-col gap-4">
      <h1 className="text-display">We couldn't find that ad</h1>
      <p className="text-body text-muted">It may have been removed, or the link may be out of date.</p>
      <Link to={`/stations/${stationId}/ads`} className="text-label text-accent underline underline-offset-4">
        Go to your ads
      </Link>
    </div>
  );
}

/** One ad: its audio, buttons, schedule and history, with rename and remove for those who may change it. */
export function AdDetailPage() {
  const station = useRequiredCurrentStation();
  const { adId = '' } = useParams();
  const ad = useAd(station.id, adId);
  const [searchParams] = useSearchParams();
  const [openDialog, setOpenDialog] = useState<'rename' | 'remove' | null>(null);
  const canChange = canChangeStationContent(station);
  const requestedTab = searchParams.get('tab');
  const currentTab: TabId = TABS.find((tab) => tab.id === requestedTab)?.id ?? 'overview';

  if (ad.isPending) return <Skeleton className="h-96 w-full" />;
  if (ad.isError) {
    if (ad.error instanceof ApiError && ad.error.httpStatus === 404) return <AdNotFound stationId={station.id} />;
    return (
      <div className="flex flex-col items-start gap-3">
        <ErrorNotice error={ad.error} title="We couldn't load this ad" />
        <Button variant="secondary" onClick={() => void ad.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const detail = ad.data;
  const tabs: LinkTab[] = TABS.map((tab) => ({ id: tab.id, label: tab.label, to: tab.id === 'overview' ? '?' : `?tab=${tab.id}`, isCurrent: currentTab === tab.id }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        breadcrumb={[{ label: 'Ads', to: `/stations/${station.id}/ads` }, { label: detail.title }]}
        title={detail.title}
        actions={
          canChange ? (
            <>
              <Button variant="secondary" onClick={() => setOpenDialog('rename')}>
                <Icon name="edit" size={18} />
                Rename
              </Button>
              <Button variant="danger" onClick={() => setOpenDialog('remove')}>
                <Icon name="trash" size={18} />
                Remove ad
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-label">
          <ClientAvatar clientId={detail.client.id} name={detail.client.name} />
          {detail.client.name}
        </span>
        <CampaignStatusBadge status={detail.campaign?.displayStatus ?? null} />
        <FileStatusBadge status={detail.status} />
      </div>

      <LinkTabs label="Ad sections" tabs={tabs} />

      {currentTab === 'overview' ? <AdOverviewTab ad={detail} station={station} /> : null}
      {currentTab === 'buttons' ? <AdButtonsTab ad={detail} station={station} /> : null}
      {currentTab === 'schedule' ? <AdScheduleTab ad={detail} /> : null}
      {currentTab === 'history' ? <AdHistoryTab stationId={station.id} adId={detail.id} /> : null}

      {openDialog === 'rename' ? <RenameAdDialog stationId={station.id} adId={detail.id} currentTitle={detail.title} onClose={() => setOpenDialog(null)} /> : null}
      {openDialog === 'remove' ? <RemoveAdDialog stationId={station.id} adId={detail.id} adTitle={detail.title} onClose={() => setOpenDialog(null)} /> : null}
    </div>
  );
}
