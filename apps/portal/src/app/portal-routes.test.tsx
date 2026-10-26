import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { portalAreaOf, returnPathFor, returnPathFrom } from '../features/sign-in/sign-in-page';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../test/fake-api';
import { renderPortalAt } from '../test/render-portal';
import { queryClient } from './portal-api';
import { PORTAL_ROUTES } from './portal-routes';
import { isPageDownloadFailure } from './route-error-page';

const notSignedIn = {
  'GET /auth/me': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
  'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
};

/** A simulated person; no pause between key presses keeps long passwords fast on slow machines. */
const person = userEvent.setup({ delay: null });

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('signing in', () => {
  it('sends someone who is not signed in to Sign in, then back to the page they asked for', async () => {
    const user = signedInUserWith();
    const stationId = user.stations[0]?.id as string;
    const fakeApi = installFakeApi({
      ...notSignedIn,
      'POST /auth/sign-in': () => jsonResponse(200, user),
    });

    const { router } = renderPortalAt(`/stations/${stationId}/account`);

    expect(await screen.findByRole('heading', { name: 'Sign in to your station' })).toBeInTheDocument();
    await person.type(screen.getByLabelText('Email'), 'chanda@example.test');
    await person.type(screen.getByLabelText('Password'), 'amber kettle rainy harbour');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/stations/${stationId}/account`);
    expect(fakeApi.calls.find((call) => call.path === '/auth/sign-in')?.body).toEqual({
      email: 'chanda@example.test',
      password: 'amber kettle rainy harbour',
    });
  });

  it('lands on the first station’s overview when there was no page to return to', async () => {
    const user = signedInUserWith();
    installFakeApi({ ...notSignedIn, 'POST /auth/sign-in': () => jsonResponse(200, user) });

    const { router } = renderPortalAt('/sign-in');
    await person.type(await screen.findByLabelText('Email'), 'chanda@example.test');
    await person.type(screen.getByLabelText('Password'), 'amber kettle rainy harbour');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/stations/${user.stations[0]?.id}/overview`);
  });

  it('explains a refused sign-in in plain words with a reference code, and never tries a session refresh for it', async () => {
    const fakeApi = installFakeApi({
      ...notSignedIn,
      'POST /auth/sign-in': () => errorResponse(401, 'INVALID_CREDENTIALS', 'The email or password is not correct.', 'f00dcafe'),
    });

    renderPortalAt('/sign-in');
    await person.type(await screen.findByLabelText('Email'), 'chanda@example.test');
    await person.type(screen.getByLabelText('Password'), 'wrong password entirely');
    const refreshesBefore = fakeApi.calls.filter((call) => call.path === '/auth/refresh').length;
    await person.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The email or password is not correct.');
    expect(alert).toHaveTextContent('Reference: f00dcafe');
    expect(fakeApi.calls.filter((call) => call.path === '/auth/refresh')).toHaveLength(refreshesBefore);
  });

  it('shows and hides the password on request', async () => {
    installFakeApi(notSignedIn);
    renderPortalAt('/sign-in');

    const passwordField = await screen.findByLabelText('Password');
    expect(passwordField).toHaveAttribute('type', 'password');
    expect(passwordField).toHaveAttribute('autocomplete', 'current-password');
    await person.click(screen.getByRole('button', { name: 'Show' }));
    expect(passwordField).toHaveAttribute('type', 'text');
    await person.click(screen.getByRole('button', { name: 'Hide' }));
    expect(passwordField).toHaveAttribute('type', 'password');
  });

  it('after signing in, a page left open that belongs to someone else (another station) is not where the person lands: their own station is', async () => {
    const user = signedInUserWith();
    const anotherStation = '0190f1a2-0000-7000-8000-0000000009f9';
    const fakeApi = installFakeApi({ ...notSignedIn, 'POST /auth/sign-in': () => jsonResponse(200, user) });

    const { router } = renderPortalAt(`/stations/${anotherStation}/application`);
    expect(await screen.findByRole('heading', { name: 'Sign in to your station' })).toBeInTheDocument();
    await person.type(screen.getByLabelText('Email'), 'chanda@example.test');
    await person.type(screen.getByLabelText('Password'), 'amber kettle rainy harbour');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/stations/${user.stations[0]?.id}/overview`);
    expect(fakeApi.calls.some((call) => call.path.includes(anotherStation))).toBe(false);
  });

  it('returns a person only to a page they can open: their own stations, the console for a super admin, the client pages for a client, and an invitation for anyone', () => {
    const member = signedInUserWith([{}, {}]);
    const [own, alsoOwn] = member.stations.map((station) => station.id);
    const other = '0190f1a2-0000-7000-8000-0000000009f9';
    const superAdmin = { ...signedInUserWith([]), user: { ...member.user, platformRole: 'SUPER_ADMIN' as const } };
    const client = { ...signedInUserWith([]), clientAccesses: [{ stationId: own as string, stationName: 'Station A', frequencyLabel: '98.1 FM', clientId: 'c1', clientName: 'Brand A' }] };
    const nobody = signedInUserWith([]);
    const back = (signedIn: typeof member, from: string) => returnPathFor(signedIn, { from });

    // A station's pages: the person's own stations only, however the address is spelled.
    expect(back(member, `/stations/${own}/ads`)).toBe(`/stations/${own}/ads`);
    expect(back(member, `/stations/${alsoOwn}/team`)).toBe(`/stations/${alsoOwn}/team`);
    expect(back(member, `/STATIONS/${own}/ads`)).toBe(`/STATIONS/${own}/ads`);
    expect(back(member, `/stations/${other}/application`)).toBeNull();
    expect(back(member, `/Stations/${other}/application`)).toBeNull();
    expect(back(member, `/%73tations/${other}/application`)).toBeNull();
    expect(back(member, `/stations/${other}/overview?tab=ads#top`)).toBeNull();
    // The console and the second factor: a super admin only.
    expect(back(member, '/admin/applications')).toBeNull();
    expect(back(member, '/Admin/applications')).toBeNull();
    expect(back(member, '/two-factor')).toBeNull();
    expect(back(superAdmin, '/admin/stations')).toBe('/admin/stations');
    expect(back(superAdmin, '/two-factor')).toBe('/two-factor');
    expect(back(superAdmin, `/stations/${own}/overview`)).toBeNull();
    expect(back(superAdmin, '/client')).toBeNull();
    // The client area: a client's own adverts; another station's advert becomes their home; a station's people go home.
    expect(back(client, '/client')).toBe('/client');
    expect(back(client, '/client/notifications')).toBe('/client/notifications');
    expect(back(client, `/client/stations/${own}/ads/a1`)).toBe(`/client/stations/${own}/ads/a1`);
    expect(back(client, `/client/stations/${other}/ads/a1`)).toBe('/client');
    expect(back(client, `/Client/Stations/${other}/ads/a1`)).toBe('/client');
    expect(back(client, `/stations/${own}/overview`)).toBeNull();
    expect(back(member, '/client/notifications')).toBeNull();
    // Someone with no station and no access left: the client home tells them so (P5C-ONBOARDING-06), from any client page.
    expect(back(nobody, '/client')).toBe('/client');
    expect(back(nobody, `/client/stations/${own}/ads/a1`)).toBe('/client');
    expect(back(nobody, '/client/notifications')).toBe('/client');
    expect(back(nobody, '/Client')).toBe('/client');
    // Read as the router reads it: these answers depend on the decoding.
    expect(back(client, `/client/%73tations/${other}/ads/a1`)).toBe('/client');
    expect(back(member, `/%73tations/${own}/ads`)).toBe(`/%73tations/${own}/ads`);
    // An invitation that named its email is kept only for that email, whatever its capitals.
    expect(returnPathFor(member, { from: '/invitations/accept', forEmail: 'someone.else@example.test' })).toBeNull();
    expect(returnPathFor(member, { from: '/invitations/accept', forEmail: member.user.email.toUpperCase() })).toBe('/invitations/accept');
    expect([portalAreaOf('/Client/notifications'), portalAreaOf('/%63lient'), portalAreaOf('/'), portalAreaOf('/%E0%A4%A')]).toEqual(['client', 'client', '', null]);
    // The invitation page and the home are kept; anything else, or an address the router could not read, goes home.
    expect(back(member, '/invitations/accept')).toBe('/invitations/accept');
    expect(back(member, '/invitations/accept/more')).toBeNull();
    expect(back(member, '/')).toBe('/');
    expect(back(client, '/administrator')).toBeNull();
    expect(back(member, '/stations/%E0%A4%A/ads')).toBeNull();
    expect(back(member, '//attacker.example/phish')).toBeNull();
  });

  it('P5C-ONBOARDING-06: a client whose last access was taken away signs in from the client area and is told so there, not "not part of a station"', async () => {
    const nobody = signedInUserWith([]);
    installFakeApi({ ...notSignedIn, 'POST /auth/sign-in': () => jsonResponse(200, nobody), 'GET /client/home': () => jsonResponse(200, { stations: [] }) });

    const { router } = renderPortalAt('/client');
    expect(await screen.findByRole('heading', { name: 'Sign in to your station' })).toBeInTheDocument();
    await person.type(screen.getByLabelText('Email'), 'chipo@brand-a.example');
    await person.type(screen.getByLabelText('Password'), 'amber kettle rainy harbour');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: "You can't view any adverts right now" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/client');
    expect(screen.queryByText("You're not part of a station yet")).not.toBeInTheDocument();
  });

  it('P5C-ONBOARDING-06: a client with no access left who signs in from any client page, even one typed with capitals, is told so on the client home', async () => {
    const nobody = signedInUserWith([]);
    installFakeApi({ ...notSignedIn, 'POST /auth/sign-in': () => jsonResponse(200, nobody), 'GET /client/home': () => jsonResponse(200, { stations: [] }) });

    const { router } = renderPortalAt('/Client/notifications');
    expect(await screen.findByRole('heading', { name: 'Sign in to your station' })).toBeInTheDocument();
    await person.type(screen.getByLabelText('Email'), 'chipo@brand-a.example');
    await person.type(screen.getByLabelText('Password'), 'amber kettle rainy harbour');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: "You can't view any adverts right now" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/client');
  });

  it("another station's sign-up pages are not found, like its other pages, and its application is never asked for", async () => {
    const user = signedInUserWith();
    const other = '0190f1a2-0000-7000-8000-0000000009f9';
    const fakeApi = installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    for (const page of ['', '/account', '/verify', '/details', '/licence']) {
      queryClient.clear();
      const { unmount } = renderPortalAt(`/stations/${other}/application${page}`);
      expect(await screen.findByRole('heading', { name: "We couldn't find that page" }), page || 'status').toBeInTheDocument();
      unmount();
    }
    expect(fakeApi.calls.some((call) => call.path.includes(other))).toBe(false);
  });

  it('accepts only return paths inside the portal', () => {
    expect(returnPathFrom({ from: '/stations/abc/ads' })).toBe('/stations/abc/ads');
    expect(returnPathFrom({ from: '//attacker.example/phish' })).toBeNull();
    expect(returnPathFrom({ from: '/\\attacker.example' })).toBeNull();
    expect(returnPathFrom({ from: 'https://attacker.example' })).toBeNull();
    expect(returnPathFrom({ from: '/sign-in' })).toBeNull();
    expect(returnPathFrom(null)).toBeNull();
  });
});

describe('the station shell', () => {
  it('treats a station the person does not belong to as not found', async () => {
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, signedInUserWith()) });
    renderPortalAt('/stations/0190f1a2-0000-7000-8000-0000000009ff/ads');
    expect(await screen.findByRole('heading', { name: "We couldn't find that page" })).toBeInTheDocument();
  });

  it.each([['OWNER'], ['MANAGER'], ['ANALYST']] as const)('shows %s the places an approved station has: Overview, Ads, Clients, Team and Station profile', async (role) => {
    const user = signedInUserWith([{ role }]);
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);
    const navigation = (await screen.findAllByRole('navigation', { name: 'Main' }))[0] as HTMLElement;
    expect(within(navigation).getAllByRole('link').map((link) => link.textContent)).toEqual(['Overview', 'Ads', 'Clients', 'Team', 'Station profile']);
  });

  it('puts Your account and Sign out under the signed-in name and role at the bottom of the menu', async () => {
    const user = signedInUserWith([{ role: 'MANAGER' }]);
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);
    expect((await screen.findAllByText('Chanda Mwale'))[0]).toBeInTheDocument();
    expect(screen.getAllByText('Manager')[0]).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Your account' })[0]).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sign out' })[0]).toBeInTheDocument();
  });

  it('draws the station like a radio dial: its name and frequency, and the needle', async () => {
    const user = signedInUserWith([{ name: 'Radio Phoenix', frequencyLabel: '89.5 FM' }]);
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);
    expect((await screen.findAllByText('Radio Phoenix'))[0]).toBeInTheDocument();
    expect(screen.getAllByText('89.5')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Look Up')[0]).toBeInTheDocument();
  });

  it('marks the page the person is on in the menu, and only that one', async () => {
    const user = signedInUserWith();
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);
    const navigation = (await screen.findAllByRole('navigation', { name: 'Main' }))[0] as HTMLElement;
    expect(within(navigation).getByRole('link', { name: 'Ads' })).toHaveAttribute('aria-current', 'page');
    for (const other of ['Overview', 'Clients', 'Station profile']) {
      expect(within(navigation).getByRole('link', { name: other })).not.toHaveAttribute('aria-current');
    }
  });

  it('tells a station under review why it cannot add ads yet, and offers only its team and profile', async () => {
    const user = signedInUserWith([{ status: 'PENDING_REVIEW' }]);
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);
    expect(await screen.findByRole('heading', { name: 'Not available yet' })).toBeInTheDocument();
    expect(screen.getAllByText(/checking this station's licence/).length).toBeGreaterThan(0);
    const navigation = (await screen.findAllByRole('navigation', { name: 'Main' }))[0] as HTMLElement;
    expect(within(navigation).getAllByRole('link').map((link) => link.textContent)).toEqual(['Team', 'Station profile']);
  });

  it('after sign-in a station under review lands on its application (P5A design §4.1), a suspended one on its profile', async () => {
    const underReview = signedInUserWith([{ status: 'PENDING_REVIEW' }]);
    const stationId = underReview.stations[0]?.id as string;
    let signedIn = underReview;
    installFakeApi({
      'GET /auth/me': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /auth/sign-in': () => jsonResponse(200, signedIn),
      [`GET /stations/${stationId}/application`]: () => jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x', request_id: 'x' } }),
      [`GET /stations/${stationId}`]: () => jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x', request_id: 'x' } }),
    });
    const first = renderPortalAt('/sign-in');
    await person.type(await screen.findByLabelText('Email'), 'chanda@example.test');
    await person.type(screen.getByLabelText('Password'), 'amber kettle rainy harbour');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(first.router.state.location.pathname).toBe(`/stations/${stationId}/application`));
    first.unmount();
    queryClient.clear();

    signedIn = signedInUserWith([{ status: 'SUSPENDED' }]);
    const second = renderPortalAt('/sign-in');
    await person.type(await screen.findByLabelText('Email'), 'chanda@example.test');
    await person.type(screen.getByLabelText('Password'), 'amber kettle rainy harbour');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(second.router.state.location.pathname).toBe(`/stations/${stationId}/profile`));
  });

  it('switches station from the station chooser when the person belongs to more than one', async () => {
    const user = signedInUserWith([{}, {}]);
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    const { router } = renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);

    const chooser = (await screen.findAllByRole('combobox', { name: 'Station' }))[0] as HTMLElement;
    await person.selectOptions(chooser, user.stations[1]?.id as string);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${user.stations[1]?.id}/overview`));
  });

  it('opens the menu drawer on small screens, and closes it with Escape', async () => {
    const user = signedInUserWith();
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);

    await person.click(await screen.findByRole('button', { name: 'Menu' }));
    const drawer = screen.getByRole('dialog', { name: 'Menu' });
    expect(within(drawer).getByRole('link', { name: 'Ads' })).toBeInTheDocument();
    await person.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
  });

  it('signs out on the server, forgets the cached account and returns to Sign in', async () => {
    const user = signedInUserWith();
    let isSignedIn = true;
    const fakeApi = installFakeApi({
      'GET /auth/me': () => (isSignedIn ? jsonResponse(200, user) : errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.')),
      'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /auth/sign-out': () => {
        isSignedIn = false;
        return jsonResponse(204, null);
      },
    });
    const { router } = renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);

    const navigation = (await screen.findAllByRole('navigation', { name: 'Main' }))[0] as HTMLElement;
    void navigation;
    await person.click(screen.getAllByRole('button', { name: 'Sign out' })[0] as HTMLElement);

    expect(await screen.findByRole('heading', { name: 'Sign in to your station' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(fakeApi.calls.some((call) => call.method === 'POST' && call.path === '/auth/sign-out')).toBe(true);
    expect(screen.queryByText('Chanda Mwale')).not.toBeInTheDocument();
  });

  it('sends the person to Sign in when their session ends while they are using the portal', async () => {
    const user = signedInUserWith();
    let sessionIsAlive = true;
    installFakeApi({
      'GET /auth/me': () => (sessionIsAlive ? jsonResponse(200, user) : errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.')),
      'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
    });
    renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);
    expect(await screen.findByRole('heading', { name: 'Ads' })).toBeInTheDocument();

    sessionIsAlive = false;
    await queryClient.refetchQueries();
    expect(await screen.findByRole('heading', { name: 'Sign in to your station' })).toBeInTheDocument();
  });
});

describe('a page that fails to draw', () => {
  it('reports the crash to the API and shows plain words, never the stack', async () => {
    const fakeApi = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, signedInUserWith()),
      'POST /client-errors': () => jsonResponse(202, null),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function BrokenPage(): never {
      throw new TypeError("Cannot read properties of undefined (reading 'title')");
    }
    const routesWithBrokenPage: RouteObject[] = [{ ...(PORTAL_ROUTES[0] as RouteObject & { index?: false }), children: [{ path: '/broken', element: <BrokenPage /> }] }];

    renderPortalAt('/broken', routesWithBrokenPage);

    expect(await screen.findByRole('heading', { name: 'Something went wrong on this page' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
    await waitFor(() => expect(fakeApi.calls.some((call) => call.path === '/client-errors')).toBe(true));
    const report = fakeApi.calls.find((call) => call.path === '/client-errors')?.body as Record<string, unknown>;
    expect(report).toMatchObject({ source: 'portal', kind: 'render', location: '/' });
    expect(String(report.message)).toContain('Cannot read properties of undefined');
    expect(await screen.findByText(/We've been told about it/)).toBeInTheDocument();
  });

  it('does not say the team was told when the report could not be sent', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, signedInUserWith()),
      'POST /client-errors': () => errorResponse(503, 'SERVICE_UNAVAILABLE', 'Please try again shortly.'),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function BrokenPage(): never {
      throw new TypeError("Cannot read properties of undefined (reading 'title')");
    }
    const routesWithBrokenPage: RouteObject[] = [{ ...(PORTAL_ROUTES[0] as RouteObject & { index?: false }), children: [{ path: '/broken', element: <BrokenPage /> }] }];

    renderPortalAt('/broken', routesWithBrokenPage);

    expect(await screen.findByText(/We couldn't tell the Look Up team about it/)).toBeInTheDocument();
    expect(screen.queryByText(/We've been told/)).not.toBeInTheDocument();
  });

  it('says a page that could not be downloaded is a connection problem, and offers to try again', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, signedInUserWith()),
      'POST /client-errors': () => jsonResponse(202, null),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const routesWithUnreachablePage: RouteObject[] = [
      {
        ...(PORTAL_ROUTES[0] as RouteObject & { index?: false }),
        children: [{ path: '/far-away', lazy: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/ad-setup-page.js')) }],
      },
    ];

    renderPortalAt('/far-away', routesWithUnreachablePage);

    expect(await screen.findByRole('heading', { name: "We couldn't load this page" })).toBeInTheDocument();
    expect(screen.getByText(/The connection may have dropped/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
  });

  it('knows a failed download in the words each browser uses', () => {
    expect(isPageDownloadFailure(new TypeError('Failed to fetch dynamically imported module: https://x/a.js'))).toBe(true); // Chrome, Edge
    expect(isPageDownloadFailure(new TypeError('error loading dynamically imported module: https://x/a.js'))).toBe(true); // Firefox
    expect(isPageDownloadFailure(new TypeError('Importing a module script failed.'))).toBe(true); // Safari
    expect(isPageDownloadFailure(new TypeError("Cannot read properties of undefined (reading 'title')"))).toBe(false);
    expect(isPageDownloadFailure('a thrown string')).toBe(false);
  });
});
