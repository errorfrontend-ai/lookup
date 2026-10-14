import type { ApplicationDetail, ApplicationQueueEntry, SignedInPortalUser } from '@lookup/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { findAccessibilityProblems } from '../../test/accessibility';
import { errorResponse, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';
import { setScreenWidth } from '../../test/screen-size';
import { duplicateWords } from './admin-words';
import { waitWords } from './two-factor-page';

const person = userEvent.setup({ delay: null });
const STATION = '0190f1a2-0000-7000-8000-0000000000c1';
const CHANGED_STATION = '0190f1a2-0000-7000-8000-0000000000c2';
const CHANGE_REQUEST = '0190f1a2-0000-7000-8000-0000000000d1';

function superAdmin(isTwoFactorCodeNeeded = false): SignedInPortalUser {
  return {
    user: { id: '0190f1a2-0000-7000-8000-0000000000aa', fullName: 'Console Operator', email: 'operator@example.test', platformRole: 'SUPER_ADMIN' },
    isTwoFactorCodeNeeded,
    stations: [],
  };
}
const queueEntry = (overrides: Partial<ApplicationQueueEntry> = {}): ApplicationQueueEntry => ({
  stationId: STATION,
  kind: 'NEW_STATION',
  changeRequestId: null,
  name: 'Sunrise FM',
  frequencyLabel: '98.1 FM',
  city: 'Ndola',
  province: 'Copperbelt',
  submittedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  duplicate: { matchedStationStatus: 'ACTIVE' },
  ...overrides,
});
const detailFor = (entry: ApplicationQueueEntry, overrides: Partial<ApplicationDetail> = {}): ApplicationDetail => ({
  ...entry,
  checks: { isPhoneVerified: true, isEmailVerified: true, hasLicenceDocument: true },
  contact: { name: 'Mutale Banda', phoneNumberMasked: '+260 97 ••• ••34' },
  licenceNumber: 'IBA/2026/0007',
  timeZone: 'Africa/Lusaka',
  coverageNote: null,
  streamAddress: null,
  licenceDocument: { fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: 1234, uploadedAt: new Date().toISOString() },
  proposedChange: null,
  ...overrides,
});
const changeEntry = queueEntry({ stationId: CHANGED_STATION, kind: 'DETAIL_CHANGE', changeRequestId: CHANGE_REQUEST, name: 'Renamed FM', duplicate: null });

function consoleApi(extra: Record<string, Parameters<typeof installFakeApi>[0][string]> = {}) {
  return installFakeApi({
    'GET /auth/me': () => jsonResponse(200, superAdmin()),
    'GET /admin/summary': () => jsonResponse(200, { waitingApplicationCount: 2, audioToCheckCount: 1 }),
    'GET /admin/applications': () => jsonResponse(200, { entries: [queueEntry(), changeEntry] }),
    [`GET /admin/applications/${STATION}`]: () => jsonResponse(200, detailFor(queueEntry())),
    [`GET /admin/applications/${CHANGED_STATION}`]: () =>
      jsonResponse(200, detailFor(changeEntry, { name: 'Sunrise FM', licenceDocument: null, proposedChange: { name: 'Renamed FM', frequencyLabel: '98.1 FM', licenceNumber: 'IBA/2026/0009', licenceDocument: null } })),
    [`POST /admin/applications/${STATION}/licence-document-link`]: () =>
      jsonResponse(200, { address: 'https://storage.example.test/licence.pdf?X-Amz-Expires=300', contentType: 'application/pdf', expiresAt: new Date().toISOString() }),
    ...extra,
  });
}

beforeEach(() => setScreenWidth(1280));
afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('getting into the console', () => {
  it('P5A-ADMIN-ACCESS-02: a super admin signs in, gives the code, and lands on the applications', async () => {
    let needsCode = true;
    const api = installFakeApi({
      'GET /auth/me': () => (needsCode ? errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.') : jsonResponse(200, superAdmin(false))),
      'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /auth/sign-in': () => jsonResponse(200, superAdmin(true)),
      'POST /auth/two-factor-code': (body) => {
        if ((body as { code: string }).code !== '287082') return errorResponse(400, 'TWO_FACTOR_CODE_INCORRECT', "That code isn't right. Use the current code in your authenticator app.");
        needsCode = false;
        return jsonResponse(204, null);
      },
      'GET /admin/summary': () => jsonResponse(200, { waitingApplicationCount: 0, audioToCheckCount: 0 }),
      'GET /admin/applications': () => jsonResponse(200, { entries: [] }),
    });
    const { router } = renderPortalAt('/sign-in');
    await person.type(await screen.findByLabelText('Email'), 'operator@example.test');
    await person.type(screen.getByLabelText('Password'), 'quiet harbour lantern please');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/two-factor'));
    const code = await screen.findByLabelText('6-digit code');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await person.type(code, '111111');
    await person.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText("That code isn't right. Use the current code in your authenticator app.")).toBeInTheDocument();
    await person.clear(code);
    await person.type(code, '287082');
    await person.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Applications' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/applications');
    expect(api.calls.filter((call) => call.path === '/auth/two-factor-code')).toHaveLength(2);
  });

  it('P5A-ADMIN-ACCESS-01: a station user is sent to their own station; a super admin without the code is sent to give it', async () => {
    const stationUser = signedInUserWith();
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, stationUser) });
    const first = renderPortalAt('/admin/applications');
    await waitFor(() => expect(first.router.state.location.pathname).toBe(`/stations/${stationUser.stations[0]?.id}/overview`));
    expect(screen.queryByText('Super admin')).not.toBeInTheDocument();
    first.unmount();
    queryClient.clear();
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, superAdmin(true)) });
    const second = renderPortalAt('/admin/stations');
    await waitFor(() => expect(second.router.state.location.pathname).toBe('/two-factor'));
  });

  it('P5A-ADMIN-ACCESS-05, -06, -08: the sidebar says "Look Up · Super admin", lists the five places with counts on two, and marks only the current one', async () => {
    consoleApi();
    renderPortalAt('/admin/applications');
    const navigation = await screen.findByRole('navigation', { name: 'Console' });
    expect(within(navigation).getByText('Look Up')).toBeInTheDocument();
    expect(within(navigation).getByText('Super admin')).toBeInTheDocument();
    await waitFor(() => expect(within(navigation).getByRole('link', { name: 'Applications 2 waiting' })).toBeInTheDocument());
    const links = within(navigation).getAllByRole('link');
    const names = ['Applications 2 waiting', 'Stations', 'Audio to check 1 waiting', 'System health', 'Find by reference code'];
    expect(links).toHaveLength(names.length);
    names.forEach((name, index) => expect(links[index]).toHaveAccessibleName(name));
    expect(links.filter((link) => link.getAttribute('aria-current') === 'page')).toEqual([links[0]]);
  });

  it('the fifth wrong code says when to try again', () => {
    expect(waitWords(null)).toBe('Too many wrong codes. Try again in 15 minutes.');
    expect(waitWords(30)).toBe('Too many wrong codes. Try again in 1 minute.');
  });
});

describe('applications', () => {
  it('journey C: the queue shows each application with its flags; the detail shows the checks, the masked phone and the licence; approving tells the station', async () => {
    const api = consoleApi({ [`POST /admin/applications/${STATION}/approval`]: () => jsonResponse(204, null) });
    renderPortalAt('/admin/applications');
    expect(await screen.findByText('Oldest first · 2 waiting')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Applications/ })).toHaveAttribute('aria-current', 'page');
    const entry = screen.getByRole('button', { name: /Sunrise FM · 98.1 FM/ });
    expect(within(entry).getByText(duplicateWords('ACTIVE'))).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Renamed FM/ })).getByText('Change to an approved station')).toBeInTheDocument();
    await person.click(entry);
    // Beside the list, the application sits under the page's own heading.
    expect(await screen.findByRole('heading', { level: 2, name: 'Sunrise FM · 98.1 FM' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sunrise FM · 98.1 FM/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Mutale Banda · +260 97 ••• ••34')).toBeInTheDocument();
    expect(await screen.findByTitle('Licence document: licence.pdf')).toHaveAttribute('src', 'https://storage.example.test/licence.pdf?X-Amz-Expires=300');
    expect(screen.getByRole('link', { name: 'Open full size' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    await person.click(screen.getByRole('button', { name: 'Approve station' }));
    expect(await screen.findByText('Approved. The station gets an SMS and email.')).toBeInTheDocument();
    expect(api.calls.some((call) => call.method === 'POST' && call.path === `/admin/applications/${STATION}/approval`)).toBe(true);
  });

  it('journey D: rejecting needs a reason of 10 characters or more, sent as written', async () => {
    const api = consoleApi({ [`POST /admin/applications/${STATION}/rejection`]: () => jsonResponse(204, null) });
    renderPortalAt(`/admin/applications/${STATION}`);
    const reason = await screen.findByLabelText('Reason (needed to reject — the station sees this)');
    await person.type(reason, 'Too short');
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    await person.type(reason, ' to read the number.');
    await person.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejected. The station gets an SMS and email with your reason.')).toBeInTheDocument();
    expect(api.calls.find((call) => call.path.endsWith('/rejection'))?.body).toEqual({ reason: 'Too short to read the number.' });
  });

  it('journey E: a change shows what is approved beside what is asked for, and is decided at its own address', async () => {
    const api = consoleApi({ [`POST /admin/change-requests/${CHANGE_REQUEST}/approval`]: () => jsonResponse(204, null) });
    renderPortalAt(`/admin/applications/${CHANGED_STATION}`);
    expect(await screen.findByText('Approved now')).toBeInTheDocument();
    expect(screen.getByText('Asked for')).toBeInTheDocument();
    expect(screen.getByText('Licence: IBA/2026/0009')).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Approve the change' }));
    await screen.findByText('Approved. The station gets an SMS and email.');
    expect(api.calls.some((call) => call.path === `/admin/change-requests/${CHANGE_REQUEST}/approval`)).toBe(true);
  });

  it('on a phone the list and the detail are separate pages, and the detail’s headings start at level one', async () => {
    setScreenWidth(375);
    consoleApi({ [`POST /admin/applications/${STATION}/approval`]: () => jsonResponse(204, null) });
    renderPortalAt(`/admin/applications/${STATION}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sunrise FM · 98.1 FM' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Checks' })).toBeInTheDocument();
    expect(screen.queryByText('Oldest first · 2 waiting')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All applications' })).toHaveAttribute('href', '/admin/applications');
    await person.click(screen.getByRole('button', { name: 'Approve station' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Decision recorded' })).toBeInTheDocument();
  });
});

describe('stations, audio, health and reference codes', () => {
  it('journey G: a station is suspended only with a reason, after the warning; a suspended one is reactivated', async () => {
    const api = consoleApi({
      'GET /admin/stations': () =>
        jsonResponse(200, {
          stations: [
            { id: STATION, name: 'Sunrise FM', frequencyLabel: '98.1 FM', city: 'Ndola', province: 'Copperbelt', status: 'ACTIVE', memberCount: 2, lastDecisionAt: null },
            { id: CHANGED_STATION, name: 'Quiet FM', frequencyLabel: '90.1 FM', city: 'Kitwe', province: 'Copperbelt', status: 'SUSPENDED', memberCount: 1, lastDecisionAt: new Date().toISOString() },
          ],
          nextCursor: null,
        }),
      [`POST /admin/stations/${STATION}/suspension`]: () => jsonResponse(204, null),
      [`POST /admin/stations/${CHANGED_STATION}/reactivation`]: () => jsonResponse(204, null),
    });
    renderPortalAt('/admin/stations');
    await person.click(await screen.findByRole('button', { name: 'Suspend' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Its ads stop reaching listeners straight away/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Suspend station' });
    expect(confirm).toBeDisabled();
    await person.type(within(dialog).getByLabelText('Reason (the station sees this)'), 'Listeners reported scam buttons.');
    await person.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await person.click(screen.getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(api.calls.some((call) => call.path.endsWith('/reactivation'))).toBe(true));
    expect(api.calls.find((call) => call.path.endsWith('/suspension'))?.body).toEqual({ reason: 'Listeners reported scam buttons.' });
  });

  it('audio to check says when there is nothing, and lets a finding be played and marked checked', async () => {
    const api = consoleApi({
      'GET /admin/audio-overlaps': () =>
        jsonResponse(200, {
          findings: [
            {
              id: '0190f1a2-0000-7000-8000-0000000000e1',
              overlapMilliseconds: 7000,
              foundAt: new Date().toISOString(),
              reviewedAt: null,
              reviewNote: null,
              first: { audioAssetNumber: 12, ads: [{ adId: 'a', adTitle: 'Summer offer', stationId: STATION, stationName: 'Sunrise FM' }] },
              second: { audioAssetNumber: 13, ads: [] },
            },
          ],
        }),
      'POST /admin/audio-overlaps/0190f1a2-0000-7000-8000-0000000000e1/preview-links': () =>
        jsonResponse(200, { first: { address: 'https://storage.example.test/a.mp3', contentType: 'audio/mpeg', expiresAt: new Date().toISOString() }, second: null }),
      'POST /admin/audio-overlaps/0190f1a2-0000-7000-8000-0000000000e1/review': () => jsonResponse(204, null),
    });
    renderPortalAt('/admin/audio-to-check');
    expect(await screen.findByText('Summer offer · Sunrise FM')).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Play A and B' }));
    expect(await screen.findByLabelText('Audio A')).toHaveAttribute('src', 'https://storage.example.test/a.mp3');
    expect(screen.getByText('Audio B has no upload to play.')).toBeInTheDocument();
    await person.type(screen.getByLabelText('Note (optional)'), 'Two cuts of one jingle.');
    await person.click(screen.getByRole('button', { name: 'Mark as checked' }));
    await waitFor(() => expect(api.calls.find((call) => call.path.endsWith('/review'))?.body).toEqual({ note: 'Two cuts of one jingle.' }));
  });

  it('System health shows the queues, the workers and the last day\'s figures', async () => {
    consoleApi({
      'GET /admin/system-health': () =>
        jsonResponse(200, {
          measuredAt: new Date().toISOString(),
          periodHours: 24,
          queues: [{ name: 'recognize', depth: 3 }, { name: 'ingest', depth: 0 }, { name: 'notify', depth: 1 }],
          workers: [{ name: 'recognize', isRunning: true }, { name: 'ingest', isRunning: false }, { name: 'notify', isRunning: true }],
          recognitionCount: 120,
          matchMillisecondsAt95thPercentile: 840,
          errorRate: 0.025,
        }),
    });
    renderPortalAt('/admin/system-health');
    expect(await screen.findByText('840 ms')).toBeInTheDocument();
    expect(screen.getByText('2.5 %')).toBeInTheDocument();
    expect(screen.getAllByText('Running')).toHaveLength(2);
    expect(screen.getByText('Not running')).toBeInTheDocument();
  });

  it('gap 14: "Find by reference code" takes the app\'s code, lists what happened, or points to the log', async () => {
    let found = true;
    consoleApi({
      'GET /admin/reference-codes/E0AE-F485': () =>
        jsonResponse(200, found
          ? { searchedFor: 'e0aef485', recognitions: [{ requestId: 'e0aef485-0000-4000-8000-000000000000', receivedAt: new Date().toISOString(), outcome: 'NO_MATCH', stationName: null }], auditEvents: [] }
          : { searchedFor: 'e0aef485', recognitions: [], auditEvents: [] }),
    });
    renderPortalAt('/admin/reference-codes');
    const field = await screen.findByLabelText('Reference code');
    await person.type(field, 'not a code');
    await person.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('Enter a code like E0AE-F485, or a full reference.')).toBeInTheDocument();
    await person.clear(field);
    await person.type(field, 'E0AE-F485');
    await person.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText(/^No match ·/)).toBeInTheDocument();
    found = false;
    await person.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('Nothing in the database matches. Search the server log for the request id starting e0aef485.')).toBeInTheDocument();
  });
});

describe.each([375, 1280])('accessibility of the console at %i px', (width) => {
  beforeEach(() => setScreenWidth(width));
  it.each([
    ['/admin/applications', 'Applications'],
    [`/admin/applications/${STATION}`, 'Sunrise FM · 98.1 FM'],
    ['/admin/stations', 'Stations'],
    ['/admin/audio-to-check', 'Audio to check'],
    ['/admin/reference-codes', 'Find by reference code'],
  ])('%s', async (path, heading) => {
    consoleApi({
      'GET /admin/stations': () => jsonResponse(200, { stations: [], nextCursor: null }),
      'GET /admin/audio-overlaps': () => jsonResponse(200, { findings: [] }),
    });
    renderPortalAt(path);
    await screen.findByRole('heading', { name: heading });
    expect(await findAccessibilityProblems()).toEqual([]);
  });
});
