import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { returnPathFrom } from '../features/sign-in/sign-in-page';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../test/fake-api';
import { renderPortalAt } from '../test/render-portal';
import { queryClient } from './portal-api';
import { PORTAL_ROUTES } from './portal-routes';

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

  it('lands on the first station’s ads when there was no page to return to', async () => {
    const user = signedInUserWith();
    installFakeApi({ ...notSignedIn, 'POST /auth/sign-in': () => jsonResponse(200, user) });

    const { router } = renderPortalAt('/sign-in');
    await person.type(await screen.findByLabelText('Email'), 'chanda@example.test');
    await person.type(screen.getByLabelText('Password'), 'amber kettle rainy harbour');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Ads' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/stations/${user.stations[0]?.id}/ads`);
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

  it.each([['OWNER'], ['MANAGER'], ['ANALYST']] as const)('shows %s the places an approved station has: Ads, Clients and Station profile', async (role) => {
    const user = signedInUserWith([{ role }]);
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);
    const navigation = (await screen.findAllByRole('navigation', { name: 'Main' }))[0] as HTMLElement;
    expect(within(navigation).getAllByRole('link').map((link) => link.textContent)).toEqual(['Ads', 'Clients', 'Station profile']);
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
  });

  it('tells a station under review why it cannot add ads yet, and offers only its profile', async () => {
    const user = signedInUserWith([{ status: 'PENDING_REVIEW' }]);
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);
    expect(await screen.findByRole('heading', { name: 'Not available yet' })).toBeInTheDocument();
    expect(screen.getAllByText(/checking this station's licence/).length).toBeGreaterThan(0);
    const navigation = (await screen.findAllByRole('navigation', { name: 'Main' }))[0] as HTMLElement;
    expect(within(navigation).getAllByRole('link').map((link) => link.textContent)).toEqual(['Station profile']);
  });

  it('after sign-in a station under review lands on its profile, not on a page it cannot use', async () => {
    const user = signedInUserWith([{ status: 'PENDING_REVIEW' }]);
    installFakeApi({
      'GET /auth/me': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /auth/sign-in': () => jsonResponse(200, user),
      [`GET /stations/${user.stations[0]?.id}`]: () => jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x', request_id: 'x' } }),
    });
    const { router } = renderPortalAt('/sign-in');
    await person.type(await screen.findByLabelText('Email'), 'chanda@example.test');
    await person.type(screen.getByLabelText('Password'), 'amber kettle rainy harbour');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${user.stations[0]?.id}/profile`));
  });

  it('switches station from the station chooser when the person belongs to more than one', async () => {
    const user = signedInUserWith([{}, {}]);
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    const { router } = renderPortalAt(`/stations/${user.stations[0]?.id}/ads`);

    const chooser = (await screen.findAllByRole('combobox', { name: 'Station' }))[0] as HTMLElement;
    await person.selectOptions(chooser, user.stations[1]?.id as string);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${user.stations[1]?.id}/ads`));
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
  });
});
