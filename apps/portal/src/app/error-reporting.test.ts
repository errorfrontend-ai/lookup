import { ClientErrorReport } from '@lookup/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, jsonResponse } from '../test/fake-api';
import { installGlobalErrorHandlers, reportClientError } from './error-reporting';

afterEach(() => {
  vi.unstubAllGlobals();
});

function sentReports(fakeApi: ReturnType<typeof installFakeApi>) {
  return fakeApi.calls.filter((call) => call.method === 'POST' && call.path === '/client-errors').map((call) => call.body);
}

describe('client error reporting', () => {
  it('sends reports the API contract accepts, trimmed to its limits, and says the API took it', async () => {
    const fakeApi = installFakeApi({ 'POST /client-errors': () => jsonResponse(202, null) });

    await expect(reportClientError({ kind: 'reported', message: 'x'.repeat(2_000), stack: 'y'.repeat(20_000) })).resolves.toBe(true);

    const [report] = sentReports(fakeApi);
    expect(ClientErrorReport.safeParse(report).success).toBe(true);
    expect((report as { message: string }).message).toHaveLength(500);
    expect((report as { stack: string }).stack).toHaveLength(8_000);
  });

  it('reports errors nothing caught and promises nobody was waiting for', () => {
    const fakeApi = installFakeApi({ 'POST /client-errors': () => jsonResponse(202, null) });
    installGlobalErrorHandlers();

    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught thing', error: new Error('Uncaught thing') }));
    const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
    rejection.reason = new Error('Nobody awaited this');
    window.dispatchEvent(rejection);

    expect(sentReports(fakeApi)).toEqual([
      expect.objectContaining({ source: 'portal', kind: 'uncaught', message: 'Uncaught thing' }),
      expect.objectContaining({ source: 'portal', kind: 'unhandled-rejection', message: 'Nobody awaited this' }),
    ]);
  });

  it('never throws when the report itself cannot be sent, and says it was not sent', async () => {
    installFakeApi({ 'POST /client-errors': () => jsonResponse(503, null) });
    await expect(reportClientError({ kind: 'reported', message: 'refused' })).resolves.toBe(false);

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(reportClientError({ kind: 'reported', message: 'offline' })).resolves.toBe(false);

    vi.stubGlobal('fetch', vi.fn(() => {
      throw new TypeError('fetch is broken');
    }));
    await expect(reportClientError({ kind: 'reported', message: 'broken fetch' })).resolves.toBe(false);
  });
});
