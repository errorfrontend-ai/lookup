import { useEffect } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { NotFoundPage } from '../components/plain-pages';
import { reportClientError } from './error-reporting';

/**
 * The router catches errors thrown while drawing a page before the outer ErrorBoundary sees them, and
 * its built-in screen would show the stack. This page reports the error and shows plain words instead.
 */
export function RouteErrorPage() {
  const routeError = useRouteError();
  const isNotFound = isRouteErrorResponse(routeError) && routeError.status === 404;

  useEffect(() => {
    if (isNotFound) return;
    const error = routeError instanceof Error ? routeError : new Error(String(routeError));
    reportClientError({ kind: 'render', message: error.message, stack: error.stack });
  }, [routeError, isNotFound]);

  if (isNotFound) return <NotFoundPage />;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-title">Something went wrong on this page</h1>
      <p className="text-body text-muted">We've been told about it. Reloading usually fixes it.</p>
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
