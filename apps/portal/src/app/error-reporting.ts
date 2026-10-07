import type { ClientErrorReport } from '@lookup/contracts';

/** A crash report as the portal raises it; where it happened and who sent it are added when it is sent. */
export type ClientErrorDraft = Omit<ClientErrorReport, 'source' | 'location'>;

/**
 * Sends a client crash to the API (POST /api/v1/client-errors), so it reaches the developers rather
 * than staying on one station's screen. Resolves to whether the API accepted it, so a screen says the
 * team was told only when that is true. Reporting must never cause another error, so a failure to
 * report resolves to false instead of throwing (there is nowhere left to report it to).
 */
export async function reportClientError(report: ClientErrorDraft): Promise<boolean> {
  try {
    const body: ClientErrorReport = {
      source: 'portal',
      location: window.location.pathname,
      ...report,
      message: report.message.slice(0, 500) || 'Unknown error',
      stack: report.stack?.slice(0, 8000),
    };
    const response = await fetch('/api/v1/client-errors', {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Errors nothing caught, and promises that failed with nobody waiting for them. */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    void reportClientError({ kind: 'uncaught', message: String(event.message), stack: event.error instanceof Error ? event.error.stack : undefined });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    void reportClientError({
      kind: 'unhandled-rejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
