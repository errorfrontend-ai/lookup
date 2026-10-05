import type { ClientErrorReport } from '@lookup/contracts';

/**
 * Sends a client crash to the API (POST /api/v1/client-errors), so it reaches the developers rather
 * than staying on one station's screen. Reporting must never cause another error, so failures to
 * report are swallowed on purpose (there is nowhere left to report them to).
 */
export function reportClientError(report: Omit<ClientErrorReport, 'source' | 'location'>): void {
  const body: ClientErrorReport = {
    source: 'portal',
    location: window.location.pathname,
    ...report,
    message: report.message.slice(0, 500) || 'Unknown error',
    stack: report.stack?.slice(0, 8000),
  };
  try {
    void fetch('/api/v1/client-errors', {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  } catch {
    // Nothing more can be done from here.
  }
}

/** Errors nothing caught, and promises that failed with nobody waiting for them. */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    reportClientError({ kind: 'uncaught', message: String(event.message), stack: event.error instanceof Error ? event.error.stack : undefined });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    reportClientError({
      kind: 'unhandled-rejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
