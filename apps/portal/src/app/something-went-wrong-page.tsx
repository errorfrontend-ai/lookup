import { useEffect, useRef, useState } from 'react';
import { type ClientErrorDraft, reportClientError } from './error-reporting';

export type CrashReportState = 'sending' | 'sent' | 'not-sent';

/**
 * Sends a crash report once and says how it went. A report object is sent only once, even when React
 * runs the effect twice (as it does in development), and a newer report starts again from 'sending'.
 */
export function useCrashReport(report: ClientErrorDraft | null): CrashReportState {
  const [outcome, setOutcome] = useState<{ report: ClientErrorDraft; wasSent: boolean } | null>(null);
  const reportAlreadySent = useRef<ClientErrorDraft | null>(null);

  useEffect(() => {
    if (!report || reportAlreadySent.current === report) return;
    reportAlreadySent.current = report;
    void reportClientError(report).then((wasSent) => setOutcome({ report, wasSent }));
  }, [report]);

  if (!outcome || outcome.report !== report) return 'sending';
  return outcome.wasSent ? 'sent' : 'not-sent';
}

const WHAT_HAPPENS_NEXT: Record<CrashReportState, string> = {
  sending: 'Reloading usually fixes it.',
  sent: "We've been told about it. Reloading usually fixes it.",
  'not-sent': "Reloading usually fixes it. We couldn't tell the Look Up team about it from here, so if it keeps happening, let them know what you were doing.",
};

/**
 * What a person sees when a page fails to draw: plain words and a way out, never the error itself. It
 * says the team has been told only once the report has reached the API.
 */
export function SomethingWentWrongPage({ reportState }: { reportState: CrashReportState }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-title">Something went wrong on this page</h1>
      <p className="text-body text-muted" role="status">
        {WHAT_HAPPENS_NEXT[reportState]}
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="min-h-11 rounded-md bg-accent px-5 text-label text-on-accent hover:bg-accent-hover"
      >
        Reload the page
      </button>
    </main>
  );
}
