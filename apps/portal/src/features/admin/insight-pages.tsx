import type { AudioOverlapFinding, AudioOverlapList, AudioOverlapPreviewLinks, AudioOverlapSide, ReferenceCodeSearchResult, SystemHealth } from '@lookup/contracts';
import { readReferenceCodeQuery } from '@lookup/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { portalApi } from '../../app/portal-api';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { TextField } from '../../components/text-field';
import { ADMIN_SUMMARY_QUERY_KEY } from './admin-shell';
import { actionWords, ageWords, OUTCOME_WORDS } from './admin-words';

const WHEN_FORMAT = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const OVERLAPS_QUERY_KEY = ['admin', 'audio-overlaps'] as const;

// ---- Audio to check ---------------------------------------------------------------------------------------

/**
 * "Audio to check" (P5A design §4.4; P5A-OVERLAP-REVIEW-*): each finding with players for the two recordings (links
 * asked for only on Play), how long they overlap, and the stations and ads using each; "Mark as checked" with a note.
 */
export function AudioToCheckPage() {
  const findings = useQuery({ queryKey: OVERLAPS_QUERY_KEY, queryFn: () => portalApi.get<AudioOverlapList>('/admin/audio-overlaps') });
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-display">Audio to check</h1>
      {findings.isError ? <ErrorNotice error={findings.error} title="We couldn't load the findings" /> : null}
      {findings.isPending ? <p className="text-body text-muted">Loading…</p> : null}
      {findings.isSuccess && findings.data.findings.length === 0 ? (
        <p className="text-body text-muted">Nothing to check. Overlapping audio shows up here once overlap detection is switched on.</p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {findings.data?.findings.map((finding) => (
          <li key={finding.id}>
            <FindingCard finding={finding} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SideDescription({ label, side }: { label: string; side: AudioOverlapSide }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-label">
        {label} · recording {side.audioAssetNumber}
      </span>
      {side.ads.length === 0 ? (
        <span className="text-caption text-muted">No ad uses it now.</span>
      ) : (
        <ul className="text-caption text-muted">
          {side.ads.map((ad) => (
            <li key={ad.adId}>
              {ad.adTitle} · {ad.stationName ?? 'a station still signing up'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FindingCard({ finding }: { finding: AudioOverlapFinding }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const previews = useMutation({ mutationFn: () => portalApi.post<AudioOverlapPreviewLinks>(`/admin/audio-overlaps/${finding.id}/preview-links`) });
  const review = useMutation({
    mutationFn: () => portalApi.post<void>(`/admin/audio-overlaps/${finding.id}/review`, { note: note.trim() || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: OVERLAPS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ADMIN_SUMMARY_QUERY_KEY });
    },
  });
  return (
    <section aria-label={`Recordings ${finding.first.audioAssetNumber} and ${finding.second.audioAssetNumber}`} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <p className="text-body">
        {(finding.overlapMilliseconds / 1000).toFixed(1)} seconds overlap · found {ageWords(finding.foundAt)}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <SideDescription label="Audio A" side={finding.first} />
        <SideDescription label="Audio B" side={finding.second} />
      </div>
      {previews.data ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {previews.data.first ? <audio controls src={previews.data.first.address} aria-label="Audio A" className="w-full" /> : <span className="text-caption text-muted">Audio A has no upload to play.</span>}
          {previews.data.second ? <audio controls src={previews.data.second.address} aria-label="Audio B" className="w-full" /> : <span className="text-caption text-muted">Audio B has no upload to play.</span>}
        </div>
      ) : (
        <Button variant="secondary" className="self-start" onClick={() => previews.mutate()} isBusy={previews.isPending} busyLabel="Getting the audio…">
          Play A and B
        </Button>
      )}
      {previews.isError ? <ErrorNotice error={previews.error} /> : null}
      {finding.reviewedAt ? (
        <p className="text-body text-muted">
          Checked {ageWords(finding.reviewedAt)}
          {finding.reviewNote ? `: ${finding.reviewNote}` : ''}
        </p>
      ) : (
        <>
          <TextField label="Note (optional)" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          {review.isError ? <ErrorNotice error={review.error} /> : null}
          <Button className="self-start" onClick={() => review.mutate()} isBusy={review.isPending} busyLabel="Saving…">
            Mark as checked
          </Button>
        </>
      )}
    </section>
  );
}

// ---- System health --------------------------------------------------------------------------------------------

const QUEUE_LABELS: Record<string, string> = { recognize: 'Recognize', ingest: 'Ingest', notify: 'Notifications' };

/** System health (P5A design §4.4, §4.6): the queues, the workers, the last day's match time and error rate; every 30 s. */
export function SystemHealthPage() {
  const health = useQuery({ queryKey: ['admin', 'system-health'], queryFn: () => portalApi.get<SystemHealth>('/admin/system-health'), refetchInterval: 30_000 });
  const data = health.data;
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-display">System health</h1>
      {health.isError ? <ErrorNotice error={health.error} title="We couldn't read the system's health" /> : null}
      {health.isPending ? <p className="text-body text-muted">Loading…</p> : null}
      {data ? (
        <>
          <section aria-labelledby="health-queues" className="flex flex-col gap-2">
            <h2 id="health-queues" className="text-title">
              Queue depth
            </h2>
            <dl className="grid gap-3 sm:grid-cols-3">
              {data.queues.map((queue) => (
                <div key={queue.name} className="rounded-md border border-line bg-surface p-3">
                  <dt className="text-caption text-muted">{QUEUE_LABELS[queue.name]}</dt>
                  <dd className="text-display tabular-nums">{queue.depth}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section aria-labelledby="health-workers" className="flex flex-col gap-2">
            <h2 id="health-workers" className="text-title">
              Workers
            </h2>
            <dl className="grid gap-3 sm:grid-cols-3">
              {data.workers.map((worker) => (
                <div key={worker.name} className="rounded-md border border-line bg-surface p-3">
                  <dt className="text-caption text-muted">{QUEUE_LABELS[worker.name]}</dt>
                  <dd className={`text-label ${worker.isRunning ? 'text-success' : 'text-danger'}`}>{worker.isRunning ? 'Running' : 'Not running'}</dd>
                </div>
              ))}
            </dl>
          </section>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-line bg-surface p-3">
              <dt className="text-caption text-muted">Recognitions (last {data.periodHours} hours)</dt>
              <dd className="text-display tabular-nums">{data.recognitionCount}</dd>
            </div>
            <div className="rounded-md border border-line bg-surface p-3">
              <dt className="text-caption text-muted">Match time (95th percentile, last 24 hours)</dt>
              <dd className="text-display tabular-nums">{data.matchMillisecondsAt95thPercentile === null ? '—' : `${data.matchMillisecondsAt95thPercentile} ms`}</dd>
            </div>
            <div className="rounded-md border border-line bg-surface p-3">
              <dt className="text-caption text-muted">Error rate (last 24 hours)</dt>
              <dd className="text-display tabular-nums">{data.errorRate === null ? '—' : `${(data.errorRate * 100).toFixed(1)} %`}</dd>
            </div>
          </dl>
          <p className="text-caption text-muted">Measured {WHEN_FORMAT.format(new Date(data.measuredAt))}. Refreshes every 30 seconds.</p>
        </>
      ) : null}
    </div>
  );
}

// ---- Find by reference code -------------------------------------------------------------------------------------

/**
 * "Find by reference code" (P5A design §4.4, §4.6; gap 14): the code as the app shows it (XXXX-XXXX) or a full
 * request id, matched against the last 30 days of recognitions and audit events; otherwise, where to look in the log.
 */
export function ReferenceCodesPage() {
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const search = useMutation({ mutationFn: (code: string) => portalApi.get<ReferenceCodeSearchResult>(`/admin/reference-codes/${encodeURIComponent(code)}`) });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!readReferenceCodeQuery(typed)) return setProblem('Enter a code like E0AE-F485, or a full reference.');
    setProblem(null);
    search.mutate(typed.trim());
  };
  const result = search.data;
  const isEmpty = result && result.recognitions.length === 0 && result.auditEvents.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-display">Find by reference code</h1>
      <form role="search" onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <TextField label="Reference code" hint="As the app shows it (E0AE-F485), or a full reference from the portal." value={typed} onChange={(event) => setTyped(event.target.value)} error={problem} />
        </div>
        <Button type="submit" variant="secondary" isBusy={search.isPending} busyLabel="Searching…">
          Find
        </Button>
      </form>
      {search.isError ? <ErrorNotice error={search.error} /> : null}
      {isEmpty ? (
        <p className="text-body">Nothing in the database matches. Search the server log for the request id starting {result.searchedFor.slice(0, 8)}.</p>
      ) : null}
      {result && result.recognitions.length > 0 ? (
        <section aria-labelledby="found-recognitions" className="flex flex-col gap-2">
          <h2 id="found-recognitions" className="text-title">
            Recognitions
          </h2>
          <ul className="flex flex-col gap-2">
            {result.recognitions.map((recognition) => (
              <li key={`${recognition.requestId}-${recognition.receivedAt}`} className="rounded-md border border-line bg-surface p-3 text-body">
                {OUTCOME_WORDS[recognition.outcome] ?? recognition.outcome} · {WHEN_FORMAT.format(new Date(recognition.receivedAt))} · {recognition.stationName ?? 'no station'}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {result && result.auditEvents.length > 0 ? (
        <section aria-labelledby="found-audit-events" className="flex flex-col gap-2">
          <h2 id="found-audit-events" className="text-title">
            What people did
          </h2>
          <ul className="flex flex-col gap-2">
            {result.auditEvents.map((event) => (
              <li key={`${event.requestId}-${event.occurredAt}-${event.action}`} className="rounded-md border border-line bg-surface p-3 text-body">
                {actionWords(event.action)} · {WHEN_FORMAT.format(new Date(event.occurredAt))} · {event.actorName ?? 'Look Up'}
                {event.stationName ? ` · ${event.stationName}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
