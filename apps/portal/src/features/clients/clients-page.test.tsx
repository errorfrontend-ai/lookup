import type { ClientListItem } from '@lookup/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';

const person = userEvent.setup({ delay: null });
const owner = signedInUserWith([{ role: 'OWNER' }]);
const stationId = owner.stations[0]?.id as string;
const clientsPath = `/stations/${stationId}/clients`;

const brandA: ClientListItem = { id: '0190f1a2-0000-7000-8000-0000000000a1', name: 'Brand A', adCount: 3, liveNowAdCount: 1 };
const brandB: ClientListItem = { id: '0190f1a2-0000-7000-8000-0000000000b2', name: 'Brand B', adCount: 1, liveNowAdCount: 0 };
const brandC: ClientListItem = { id: '0190f1a2-0000-7000-8000-0000000000c3', name: 'Brand C', adCount: 0, liveNowAdCount: 0 };

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('Clients', () => {
  it('lists each client with how many ads it has, and marks the ones on air', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, [brandA, brandB, brandC]),
    });
    renderPortalAt(clientsPath);

    await screen.findByText('Brand A');
    const items = screen.getAllByRole('listitem').filter((item) => within(item).queryByText(/^Brand /));
    expect(items).toHaveLength(3);
    expect(within(items[0] as HTMLElement).getByText('3 ads')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('On air now')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('1 ad')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).queryByText('On air now')).not.toBeInTheDocument();
    expect(within(items[2] as HTMLElement).getByText('No ads yet')).toBeInTheDocument();
  });

  it("links to a client's ads only when it has some", async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, [brandA, brandC]),
    });
    renderPortalAt(clientsPath);

    const link = await screen.findByRole('link', { name: "See Brand A's ads" });
    expect(link).toHaveAttribute('href', `/stations/${stationId}/ads?client=${brandA.id}`);
    expect(screen.queryByRole('link', { name: "See Brand C's ads" })).not.toBeInTheDocument();
  });

  it('shows a loading state, then an explanation and a way forward when there are none', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
    });
    renderPortalAt(clientsPath);
    expect(await screen.findByRole('heading', { name: 'No clients yet' })).toBeInTheDocument();
    expect(screen.getByText('Add your first client above, then upload their ads.')).toBeInTheDocument();
    expect(screen.getByLabelText('Add a client')).toBeInTheDocument();
  });

  it('shows an analyst the list but no way to add, and says who can add', async () => {
    const analyst = signedInUserWith([{ role: 'ANALYST' }]);
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, analyst),
      [`GET /stations/${analyst.stations[0]?.id}/clients`]: () => jsonResponse(200, []),
    });
    renderPortalAt(`/stations/${analyst.stations[0]?.id}/clients`);
    expect(await screen.findByText('Clients appear here once an owner or manager adds them.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add a client')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add client' })).not.toBeInTheDocument();
  });

  it('explains a failure in plain words with its reference, and offers to try again', async () => {
    let attempts = 0;
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}/clients`]: () => {
        attempts += 1;
        return attempts === 1 ? errorResponse(500, 'INTERNAL', 'Something went wrong on our side.', 'beefbeef') : jsonResponse(200, [brandA]);
      },
    });
    renderPortalAt(clientsPath);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load your clients");
    expect(alert).toHaveTextContent('Reference: beefbeef');
    expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
    await person.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Brand A')).toBeInTheDocument();
  });

  it('adds a client, refreshes the list, clears the box and confirms', async () => {
    let clients = [brandA];
    const fakeApi = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, clients),
      [`POST /stations/${stationId}/clients`]: (body) => {
        clients = [...clients, { ...brandC, name: (body as { name: string }).name }];
        return jsonResponse(201, { id: brandC.id, name: (body as { name: string }).name });
      },
    });
    renderPortalAt(clientsPath);
    await screen.findByText('Brand A');

    await person.type(screen.getByLabelText('Add a client'), '  Brand C  ');
    expect(screen.getByText('11 / 80')).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Add client' }));

    expect(await screen.findByText('Brand C', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByLabelText('Add a client')).toHaveValue('');
    expect(screen.getByText('Brand C added')).toBeInTheDocument();
    expect(fakeApi.calls.find((call) => call.method === 'POST')?.body).toEqual({ name: 'Brand C' });
  });

  it('keeps Add client switched off until there is a name', async () => {
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, owner), [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []) });
    renderPortalAt(clientsPath);
    const addButton = await screen.findByRole('button', { name: 'Add client' });
    expect(addButton).toBeDisabled();
    await person.type(screen.getByLabelText('Add a client'), '   ');
    expect(addButton).toBeDisabled();
    await person.type(screen.getByLabelText('Add a client'), 'A');
    expect(addButton).toBeEnabled();
  });

  it("says a duplicate name is taken, next to the box, in the server's own words", async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, [brandA]),
      [`POST /stations/${stationId}/clients`]: () => errorResponse(409, 'CONFLICT', 'This station already has a client with that name.'),
    });
    renderPortalAt(clientsPath);
    await screen.findByText('Brand A');

    await person.type(screen.getByLabelText('Add a client'), 'Brand A');
    await person.click(screen.getByRole('button', { name: 'Add client' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This station already has a client with that name.');
    expect(screen.getByLabelText('Add a client')).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(screen.getByLabelText('Add a client')).toHaveValue('Brand A'));
  });
});
