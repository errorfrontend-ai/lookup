import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { ClientErrorDraft } from './error-reporting';
import { SomethingWentWrongPage, useCrashReport } from './something-went-wrong-page';

interface ErrorBoundaryState {
  hasFailed: boolean;
  report: ClientErrorDraft | null;
}

function ReportedCrashPage({ report }: { report: ClientErrorDraft | null }) {
  return <SomethingWentWrongPage reportState={useCrashReport(report)} />;
}

/**
 * Catches a screen that fails to draw, reports it, and shows a plain way out instead of a blank page.
 * (Error boundaries only catch render errors; installGlobalErrorHandlers covers the rest.)
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasFailed: false, report: null };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { hasFailed: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ report: { kind: 'render', message: error.message, stack: `${error.stack ?? ''}\n${errorInfo.componentStack ?? ''}` } });
  }

  override render(): ReactNode {
    if (!this.state.hasFailed) return this.props.children;
    return <ReportedCrashPage report={this.state.report} />;
  }
}
