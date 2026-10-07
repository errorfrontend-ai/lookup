import { useMemo } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { NotFoundPage } from '../components/plain-pages';
import type { ClientErrorDraft } from './error-reporting';
import { SomethingWentWrongPage, useCrashReport } from './something-went-wrong-page';

/**
 * Whether the error is a part of the portal that could not be downloaded (the connection dropped, or a
 * new version replaced the old files), rather than a fault in a page. Each browser words it differently.
 */
export function isPageDownloadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(message);
}

/**
 * The router catches errors thrown while drawing a page before the outer ErrorBoundary sees them, and
 * its built-in screen would show the stack. This page reports the error and shows plain words instead.
 */
export function RouteErrorPage() {
  const routeError = useRouteError();
  const isNotFound = isRouteErrorResponse(routeError) && routeError.status === 404;
  const report = useMemo((): ClientErrorDraft | null => {
    if (isNotFound) return null;
    const error = routeError instanceof Error ? routeError : new Error(String(routeError));
    return { kind: 'render', message: error.message, stack: error.stack };
  }, [routeError, isNotFound]);
  const reportState = useCrashReport(report);

  if (isNotFound) return <NotFoundPage />;
  if (isPageDownloadFailure(routeError)) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
        <h1 className="text-title">We couldn't load this page</h1>
        <p className="text-body text-muted">The connection may have dropped while it was loading. Check your connection, then try again.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="min-h-11 rounded-md bg-accent px-5 text-label text-on-accent hover:bg-accent-hover"
        >
          Try again
        </button>
      </main>
    );
  }
  return <SomethingWentWrongPage reportState={reportState} />;
}
