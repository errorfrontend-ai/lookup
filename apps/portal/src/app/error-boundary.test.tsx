import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse } from '../test/fake-api';
import { ErrorBoundary } from './error-boundary';

afterEach(() => {
  vi.restoreAllMocks();
});

function BrokenPart(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'frequencyLabel')");
}

describe('the error boundary around the whole portal', () => {
  it('shows plain words when something outside the pages fails to draw, and reports where it happened', async () => {
    const fakeApi = installFakeApi({ 'POST /client-errors': () => jsonResponse(202, null) });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <BrokenPart />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'Something went wrong on this page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeInTheDocument();
    expect(await screen.findByText(/We've been told about it/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
    const report = fakeApi.calls.find((call) => call.path === '/client-errors')?.body as Record<string, unknown>;
    expect(report).toMatchObject({ source: 'portal', kind: 'render' });
    expect(String(report.stack)).toContain('BrokenPart');
    expect(fakeApi.calls.filter((call) => call.path === '/client-errors')).toHaveLength(1);
  });

  it('says it could not tell the team, rather than that it did, when the report is refused', async () => {
    const fakeApi = installFakeApi({ 'POST /client-errors': () => errorResponse(429, 'RATE_LIMITED', 'Too many requests.') });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <BrokenPart />
      </ErrorBoundary>,
    );

    await waitFor(() => expect(fakeApi.calls.some((call) => call.path === '/client-errors')).toBe(true));
    expect(await screen.findByText(/We couldn't tell the Look Up team about it/)).toBeInTheDocument();
    expect(screen.queryByText(/We've been told/)).not.toBeInTheDocument();
  });
});
