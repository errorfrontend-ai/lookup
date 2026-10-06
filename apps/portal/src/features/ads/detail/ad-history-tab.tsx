import { Button } from '../../../components/button';
import { ErrorNotice } from '../../../components/error-notice';
import { SkeletonRows } from '../../../components/skeleton';
import { formatRelativeTime } from '../../../formatting/format-relative-time';
import { describeHistoryActor, describeHistoryEvent } from '../../../plain-words/ad-history-words';
import { useAdHistory } from '../use-ad-detail';

/** Everything that happened to the ad, newest first: who changed what, and when. */
export function AdHistoryTab({ stationId, adId }: { stationId: string; adId: string }) {
  const history = useAdHistory(stationId, adId);
  const events = history.data?.pages.flatMap((page) => page.events) ?? [];
  return (
    <section aria-label="History" className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
      <h2 className="text-heading">History</h2>
      {history.isPending ? <SkeletonRows count={4} rowClassName="h-10" /> : null}
      {history.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice error={history.error} title="We couldn't load the history" />
          <Button variant="secondary" onClick={() => void history.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      {history.isSuccess && events.length === 0 ? <p className="text-body text-muted">Nothing has been recorded for this ad yet.</p> : null}
      {events.length > 0 ? (
        <ol className="m-0 flex list-none flex-col divide-y divide-line-soft p-0">
          {events.flatMap((event) =>
            describeHistoryEvent(event).map((sentence, index) => (
              <li key={`${event.id}-${index}`} className="flex items-start justify-between gap-3 py-3 text-body">
                <span>
                  <strong>{describeHistoryActor(event)}</strong> {sentence}
                </span>
                <time dateTime={event.occurredAt} title={new Date(event.occurredAt).toLocaleString('en-GB')} className="shrink-0 text-caption text-muted">
                  {formatRelativeTime(event.occurredAt)}
                </time>
              </li>
            )),
          )}
        </ol>
      ) : null}
      {history.hasNextPage ? (
        <Button variant="secondary" className="self-start" isBusy={history.isFetchingNextPage} busyLabel="Loading…" onClick={() => void history.fetchNextPage()}>
          Show older changes
        </Button>
      ) : null}
    </section>
  );
}
