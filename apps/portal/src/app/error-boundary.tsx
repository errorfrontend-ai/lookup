import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from './error-reporting';

interface ErrorBoundaryState {
  hasFailed: boolean;
}

/**
 * Catches a screen that fails to draw, reports it, and shows a plain way out instead of a blank page.
 * (Error boundaries only catch render errors; installGlobalErrorHandlers covers the rest.)
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasFailed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasFailed: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    reportClientError({ kind: 'render', message: error.message, stack: `${error.stack ?? ''}\n${errorInfo.componentStack ?? ''}` });
  }

  override render(): ReactNode {
    if (!this.state.hasFailed) return this.props.children;
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
}
