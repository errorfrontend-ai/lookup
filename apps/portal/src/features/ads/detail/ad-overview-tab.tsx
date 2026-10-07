import type { AdDetail } from '@lookup/contracts';
import { Link } from 'react-router';
import { AdAudioPlayer } from '../../../components/ad-audio-player';
import { ListenerCardPreview } from '../../../components/listener-card-preview';
import { FileStatusBadge } from '../../../components/status-badges';
import { formatFileSize } from '../../../formatting/format-file-size';
import { formatRelativeTime } from '../../../formatting/format-relative-time';
import { describeFileStatus } from '../../../plain-words/ad-status-words';
import { describeHistoryActor, describeHistoryEvent } from '../../../plain-words/ad-history-words';
import { describeUploadRefusal } from '../../../plain-words/upload-words';
import type { MemberStation } from '../../stations/use-current-station';
import { useAdHistory } from '../use-ad-detail';
import { ScheduleFacts } from './schedule-facts';

const RECENT_CHANGES_SHOWN = 3;

function AudioCard({ ad, stationId }: { ad: AdDetail; stationId: string }) {
  const hasAudio = ad.status !== 'AWAITING_UPLOAD' && ad.status !== 'FAILED';
  const words = describeFileStatus(ad.status);
  return (
    <section aria-label="Audio" className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
      <h2 className="text-heading">Audio</h2>
      {hasAudio ? <AdAudioPlayer stationId={stationId} adId={ad.id} adTitle={ad.title} variant="full" /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <FileStatusBadge status={ad.status} />
        <span className="text-caption text-muted">{words.hint}</span>
      </div>
      {ad.status === 'FAILED' ? <p className="text-body text-danger">{describeUploadRefusal(ad.processingErrorCode)}</p> : null}
      <p className="text-caption text-muted">
        {ad.uploadedFileName ? `${ad.uploadedFileName}` : 'No file yet'}
        {ad.uploadSizeBytes ? ` · ${formatFileSize(ad.uploadSizeBytes)}` : ''}
        {ad.uploadedAt ? ` · uploaded ${formatRelativeTime(ad.uploadedAt)}` : ''}
      </p>
    </section>
  );
}

function RecentChanges({ stationId, adId }: { stationId: string; adId: string }) {
  const history = useAdHistory(stationId, adId);
  const events = (history.data?.pages[0]?.events ?? []).slice(0, RECENT_CHANGES_SHOWN);
  return (
    <section aria-label="Recent changes" className="flex flex-col gap-2 rounded-lg border border-line-soft bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-heading">Recent changes</h2>
        <Link to="?tab=history" className="inline-flex min-h-11 items-center text-label text-accent underline underline-offset-4">
          Full history
        </Link>
      </div>
      {history.isPending ? <p className="text-body text-muted">Loading…</p> : null}
      {history.isSuccess && events.length === 0 ? <p className="text-body text-muted">Nothing recorded yet.</p> : null}
      <ul className="divide-y divide-line-soft">
        {events.map((event) => (
          <li key={event.id} className="flex items-start justify-between gap-3 py-2 text-body">
            <span>
              <strong>{describeHistoryActor(event)}</strong> {describeHistoryEvent(event)[0]}
            </span>
            <span className="shrink-0 text-caption text-muted">{formatRelativeTime(event.occurredAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The ad at a glance: its audio, when it airs, what changed lately, and what listeners see. */
export function AdOverviewTab({ ad, station }: { ad: AdDetail; station: MemberStation }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_21.5rem]">
      <div className="flex flex-col gap-4">
        <AudioCard ad={ad} stationId={station.id} />
        <section aria-label="When it airs" className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-heading">When it airs</h2>
            <Link to="?tab=schedule" className="inline-flex min-h-11 items-center text-label text-accent underline underline-offset-4">
              See the week
            </Link>
          </div>
          <ScheduleFacts schedule={ad.schedule} />
        </section>
        <RecentChanges stationId={station.id} adId={ad.id} />
      </div>
      <section aria-label="What listeners see" className="flex h-fit flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-heading">What listeners see</h2>
          <Link to="?tab=buttons" className="inline-flex min-h-11 items-center text-label text-accent underline underline-offset-4">
            See the buttons
          </Link>
        </div>
        {ad.actionCard ? (
          <ListenerCardPreview card={ad.actionCard} adTitle={ad.title} clientName={ad.client.name} stationName={station.name} frequencyLabel={station.frequencyLabel} phoneWidth={280} />
        ) : (
          <p className="text-body text-muted">This ad has no buttons yet. Listeners who identify it won't see anything until you add some.</p>
        )}
      </section>
    </div>
  );
}
