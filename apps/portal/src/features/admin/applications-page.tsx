import { type ApplicationDetail, type ApplicationQueue, type ApplicationQueueEntry, MINIMUM_DECISION_REASON_LENGTH, type PrivateFileLink } from '@lookup/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { portalApi } from '../../app/portal-api';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { TextAreaField } from '../../components/text-area-field';
import { LARGE_SCREEN_QUERY, useMediaQuery } from '../../components/use-media-query';
import { ADMIN_SUMMARY_QUERY_KEY } from './admin-shell';
import { ageWords, duplicateWords } from './admin-words';

const QUEUE_QUERY_KEY = ['admin', 'applications'] as const;

/**
 * Applications (AdminQueue wireframe; P5A design §4.4; journeys C, D, E): new stations and changes asked for by
 * approved ones, oldest first. On a wide screen the list and the chosen application sit side by side; on a phone
 * they are separate pages.
 */
export function ApplicationsPage() {
  const { stationId } = useParams();
  const isWide = useMediaQuery(LARGE_SCREEN_QUERY);
  const navigate = useNavigate();
  const queue = useQuery({ queryKey: QUEUE_QUERY_KEY, queryFn: () => portalApi.get<ApplicationQueue>('/admin/applications') });
  const entries = queue.data?.entries ?? [];
  const showList = isWide || !stationId;
  const showDetail = Boolean(stationId);

  return (
    <div className="flex flex-col gap-5">
      {showList ? (
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Applications</h1>
          <p className="text-body text-muted">Oldest first · {entries.length} waiting</p>
        </div>
      ) : (
        <Link to="/admin/applications" className="text-label text-accent underline underline-offset-4">
          All applications
        </Link>
      )}
      {queue.isError ? <ErrorNotice error={queue.error} title="We couldn't load the applications" /> : null}
      <div className={isWide ? 'grid grid-cols-[minmax(0,22rem)_1fr] items-start gap-5' : 'flex flex-col gap-5'}>
        {showList ? (
          <ul className="flex flex-col gap-2">
            {queue.isPending ? <li className="text-body text-muted">Loading…</li> : null}
            {queue.isSuccess && entries.length === 0 ? <li className="text-body text-muted">Nothing is waiting for review.</li> : null}
            {entries.map((entry) => (
              <li key={`${entry.stationId}-${entry.changeRequestId ?? 'new'}`}>
                <QueueEntryButton entry={entry} isSelected={entry.stationId === stationId} onSelect={() => void navigate(`/admin/applications/${entry.stationId}`)} />
              </li>
            ))}
          </ul>
        ) : null}
        {showDetail && stationId ? <ApplicationPanel key={stationId} stationId={stationId} /> : isWide ? <p className="text-body text-muted">Choose an application to review it.</p> : null}
      </div>
    </div>
  );
}

function QueueEntryButton({ entry, isSelected, onSelect }: { entry: ApplicationQueueEntry; isSelected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={onSelect}
      className={`flex w-full flex-col items-start gap-1 rounded-md border p-3 text-left ${isSelected ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-ground'}`}
    >
      <span className="text-label">
        {entry.name} · {entry.frequencyLabel}
      </span>
      <span className="text-caption text-muted">
        {[entry.city, entry.province].filter(Boolean).join(', ')} · {ageWords(entry.submittedAt)}
      </span>
      <span className="flex flex-wrap gap-1">
        {entry.kind === 'DETAIL_CHANGE' ? <span className="rounded-pill bg-ground px-2 text-caption">Change to an approved station</span> : null}
        {entry.duplicate ? <span className="rounded-pill bg-warning-soft px-2 text-caption">{duplicateWords(entry.duplicate.matchedStationStatus)}</span> : null}
      </span>
    </button>
  );
}

function ApplicationPanel({ stationId }: { stationId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['admin', 'applications', stationId], queryFn: () => portalApi.get<ApplicationDetail>(`/admin/applications/${stationId}`) });
  const data = detail.data;
  const changeRequestId = data?.kind === 'DETAIL_CHANGE' ? data.changeRequestId : null;
  const documentToShow = data ? (changeRequestId ? data.proposedChange?.licenceDocument ?? null : data.licenceDocument) : null;
  const link = useQuery({
    queryKey: ['admin', 'licence-link', stationId, changeRequestId],
    queryFn: () =>
      portalApi.post<PrivateFileLink>(changeRequestId ? `/admin/change-requests/${changeRequestId}/licence-document-link` : `/admin/applications/${stationId}/licence-document-link`),
    enabled: Boolean(documentToShow),
    // A 5-minute link: asked again before it ends, never cached past it.
    staleTime: 4 * 60_000,
    gcTime: 4 * 60_000,
  });
  const afterDecision = async (words: string) => {
    setDone(words);
    await queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
    await queryClient.invalidateQueries({ queryKey: ADMIN_SUMMARY_QUERY_KEY });
  };
  const base = changeRequestId ? `/admin/change-requests/${changeRequestId}` : `/admin/applications/${stationId}`;
  const approve = useMutation({ mutationFn: () => portalApi.post<void>(`${base}/approval`), onSuccess: () => afterDecision('Approved. The station gets an SMS and email.') });
  const reject = useMutation({ mutationFn: () => portalApi.post<void>(`${base}/rejection`, { reason: reason.trim() }), onSuccess: () => afterDecision('Rejected. The station gets an SMS and email with your reason.') });

  if (done) {
    return (
      <section aria-live="polite" className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
        <p className="text-body">{done}</p>
        <Button variant="secondary" className="self-start" onClick={() => void navigate('/admin/applications')}>
          Back to the applications
        </Button>
      </section>
    );
  }
  if (detail.isPending) return <p className="text-body text-muted">Loading the application…</p>;
  if (detail.isError || !data) return <ErrorNotice error={detail.error} title="We couldn't load this application" />;
  const canReject = reason.trim().length >= MINIMUM_DECISION_REASON_LENGTH;

  return (
    <section aria-labelledby="application-heading" className="flex flex-col gap-5 rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 id="application-heading" className="text-title">
          {data.name} · {data.frequencyLabel}
        </h2>
        <p className="text-caption text-muted">
          {[data.city, data.province].filter(Boolean).join(', ')} · submitted {ageWords(data.submittedAt)}
        </p>
        {data.duplicate ? <p className="rounded-md bg-warning-soft px-3 py-2 text-body">{duplicateWords(data.duplicate.matchedStationStatus)}</p> : null}
      </div>
      {data.proposedChange ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <dl className="flex flex-col gap-1 rounded-md border border-line p-3">
            <dt className="text-caption text-muted">Approved now</dt>
            <dd className="text-body">{data.name} · {data.frequencyLabel}</dd>
            <dd className="text-body">Licence: {data.licenceNumber ?? 'none'}</dd>
          </dl>
          <dl className="flex flex-col gap-1 rounded-md border border-accent p-3">
            <dt className="text-caption text-muted">Asked for</dt>
            <dd className="text-body">{data.proposedChange.name} · {data.proposedChange.frequencyLabel}</dd>
            <dd className="text-body">Licence: {data.proposedChange.licenceNumber}{data.proposedChange.licenceDocument ? ' (new document)' : ''}</dd>
          </dl>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <h3 className="text-label">Checks</h3>
        <ul className="flex flex-col gap-1 text-body">
          <li>Phone: {data.checks.isPhoneVerified ? 'confirmed' : 'not confirmed'}</li>
          <li>Email: {data.checks.isEmailVerified ? 'confirmed' : 'not confirmed'}</li>
          <li>Licence document: {data.checks.hasLicenceDocument ? 'uploaded' : 'missing'}</li>
        </ul>
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-body sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Contact</dt>
        <dd>
          {data.contact.name ?? 'Not given'} · {data.contact.phoneNumberMasked ?? 'no number'}
        </dd>
        <dt className="text-muted">Licence number</dt>
        <dd>{data.licenceNumber ?? 'Not given'}</dd>
        <dt className="text-muted">Time zone</dt>
        <dd>{data.timeZone}</dd>
      </dl>
      {documentToShow ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-label">Licence document</h3>
          {link.data ? (
            <>
              {link.data.contentType === 'application/pdf' ? (
                <iframe title={`Licence document: ${documentToShow.fileName}`} src={link.data.address} className="h-96 w-full rounded-md border border-line" />
              ) : (
                <img src={link.data.address} alt={`Licence document: ${documentToShow.fileName}`} className="max-h-96 w-full rounded-md border border-line object-contain" />
              )}
              <a href={link.data.address} target="_blank" rel="noopener noreferrer" className="text-label text-accent underline underline-offset-4">
                Open full size
              </a>
            </>
          ) : link.isError ? (
            <ErrorNotice error={link.error} title="We couldn't open the licence document" />
          ) : (
            <p className="text-body text-muted">Opening the licence document…</p>
          )}
        </div>
      ) : null}
      <TextAreaField
        label="Reason (needed to reject — the station sees this)"
        placeholder="e.g. The licence photo is too blurry to read the number. Please upload a clearer copy."
        maxLength={1000}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {approve.isError ? <ErrorNotice error={approve.error} /> : null}
      {reject.isError ? <ErrorNotice error={reject.error} /> : null}
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => approve.mutate()} isBusy={approve.isPending} busyLabel="Approving…" disabled={reject.isPending}>
          {changeRequestId ? 'Approve the change' : 'Approve station'}
        </Button>
        <Button variant="danger" onClick={() => reject.mutate()} disabled={!canReject || approve.isPending} isBusy={reject.isPending} busyLabel="Rejecting…">
          Reject
        </Button>
      </div>
      <p className="text-caption text-muted">The station gets an SMS and email. Your decision goes in the audit log.</p>
    </section>
  );
}
