import { APPLICATION_REVIEW_TIME_TEXT, type StationApplication } from '@lookup/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router';
import { SIGNED_IN_USER_QUERY_KEY } from '../../app/portal-api';
import { Badge, type BadgeTone } from '../../components/badge';
import { ButtonLink } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { Icon } from '../../components/icons';
import { LoadingScreen } from '../../components/plain-pages';
import { useSignOut } from '../session/use-sign-out';
import { useStationApplication } from './use-station-application';

const WHEN_FORMAT = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** "finished" is the last stage once the application has reached it: ticked like a done stage, and the current one. */
type StageState = 'done' | 'current' | 'finished' | 'future';
interface Stage {
  name: string;
  note: string | null;
  state: StageState;
}

/** The three stages of AppStatus (P5A design §4.3), or "Rejected" with the reviewer's words. */
export function applicationStages(application: Pick<StationApplication, 'status' | 'submittedAt' | 'reviewedAt' | 'rejectionReason'>): Stage[] {
  const submitted: Stage = {
    name: 'Submitted',
    note: application.submittedAt ? WHEN_FORMAT.format(new Date(application.submittedAt)) : null,
    state: 'done',
  };
  const reviewed = application.reviewedAt ? `Reviewed ${WHEN_FORMAT.format(new Date(application.reviewedAt))}` : null;
  if (application.status === 'REJECTED') {
    return [submitted, { name: 'Under review', note: reviewed, state: 'done' }, { name: 'Rejected', note: application.rejectionReason, state: 'current' }];
  }
  if (application.status === 'ACTIVE') {
    return [submitted, { name: 'Under review', note: reviewed, state: 'done' }, { name: 'Approved', note: "We've sent you a text and an email", state: 'finished' }];
  }
  return [
    submitted,
    { name: 'Under review', note: `Usually within ${APPLICATION_REVIEW_TIME_TEXT}`, state: 'current' },
    { name: 'Approved', note: "We'll text and email you", state: 'future' },
  ];
}

/** Where the application stands, in one word beside the station's name, so nobody has to read it off the stages. */
export function applicationStatusLabel(status: StationApplication['status']): { text: string; tone: BadgeTone } | null {
  if (status === 'PENDING_REVIEW') return { text: 'Under review', tone: 'warning' };
  if (status === 'ACTIVE') return { text: 'Approved', tone: 'success' };
  if (status === 'REJECTED') return { text: 'Rejected', tone: 'danger' };
  return null;
}

/**
 * Application status (P5A design §4.3; journey B and D): where the application is, the reviewer's reason word for
 * word after a rejection, and how to change it. It looks again every minute, so an approval shows while it is open.
 */
export function ApplicationStatusPage() {
  const { stationId = '' } = useParams();
  const queryClient = useQueryClient();
  const signOut = useSignOut();
  const application = useStationApplication(stationId);
  const status = application.data?.status;
  const refetch = application.refetch;
  useEffect(() => {
    if (status !== 'PENDING_REVIEW') return undefined;
    const looking = window.setInterval(() => void refetch(), 60_000);
    return () => window.clearInterval(looking);
  }, [status, refetch]);
  // An approval changes what the station's pages offer: the signed-in person's stations are read again.
  useEffect(() => {
    if (status === 'ACTIVE') void queryClient.invalidateQueries({ queryKey: SIGNED_IN_USER_QUERY_KEY });
  }, [status, queryClient]);

  if (application.isPending) return <LoadingScreen label="Loading your application…" />;
  if (application.isError) return <main className="p-6"><ErrorNotice error={application.error} title="We couldn't load your application" /></main>;
  const saved = application.data;
  if (saved.nextStep !== 'submitted') return <Navigate to={`/stations/${stationId}/application/${saved.nextStep}`} replace />;
  const isRejected = saved.status === 'REJECTED';
  const isApproved = saved.status === 'ACTIVE';
  const statusLabel = applicationStatusLabel(saved.status);

  return (
    <div className="flex min-h-dvh flex-col bg-ground">
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2 sm:px-6">
        <span className="font-display text-title">Look Up</span>
        <button type="button" onClick={() => void signOut()} className="min-h-11 rounded-md px-3 text-label hover:bg-ground">
          Sign out
        </button>
      </header>
      <main id="main-content" className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">{isApproved ? 'Your station is approved' : isRejected ? 'Your application needs changes' : 'Thanks — your application is in'}</h1>
          <p className="flex flex-wrap items-center gap-2 text-body text-muted">
            <span>
              {saved.details.name} · {saved.details.frequencyLabel}
            </span>
            {statusLabel ? (
              <Badge tone={statusLabel.tone}>
                <span className="sr-only">Status: </span>
                {statusLabel.text}
              </Badge>
            ) : null}
          </p>
        </div>
        {isApproved ? (
          <ButtonLink to={`/stations/${stationId}/overview`} className="self-start">
            Go to your station
          </ButtonLink>
        ) : null}
        <section aria-labelledby="application-progress" className="rounded-lg border border-line bg-surface p-4 sm:p-6">
          <h2 id="application-progress" className="text-title">
            Application progress
          </h2>
          <ol className="mt-4 flex flex-col gap-4">
            {applicationStages(saved).map((stage) => {
              const isTicked = stage.state === 'done' || stage.state === 'finished';
              return (
                <li key={stage.name} aria-current={stage.state === 'current' || stage.state === 'finished' ? 'step' : undefined} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-pill border ${
                      isTicked ? 'border-success bg-success text-on-accent' : stage.state === 'current' ? (isRejected ? 'border-danger' : 'border-accent') : 'border-line'
                    }`}
                  >
                    {isTicked ? <Icon name="check" size={14} /> : null}
                  </span>
                  <div className="flex flex-col">
                    <span className={`text-label ${stage.name === 'Rejected' ? 'text-danger' : ''}`}>{stage.name}</span>
                    {stage.note ? <span className={stage.name === 'Rejected' ? 'whitespace-pre-line text-body' : 'text-caption text-muted'}>{stage.note}</span> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
        {isApproved ? null : (
          <section aria-labelledby="while-you-wait" className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 sm:p-6">
            <h2 id="while-you-wait" className="text-title">
              {isRejected ? 'What to do now' : 'While you wait'}
            </h2>
            <p className="text-body">
              {isRejected
                ? 'Fix what the reviewer asked, then submit again.'
                : 'You can still change your details. Uploading ads unlocks once your station is approved.'}
            </p>
            <ButtonLink to={`/stations/${stationId}/application/details`} variant={isRejected ? 'primary' : 'secondary'} className="self-start">
              {isRejected ? 'Fix and submit again' : 'Edit application'}
            </ButtonLink>
          </section>
        )}
        <p className="text-caption text-muted">If anything is missing we'll tell you exactly what to fix — nothing is lost.</p>
      </main>
    </div>
  );
}
