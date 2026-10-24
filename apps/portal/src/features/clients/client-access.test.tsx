import type { ClientListItem, ClientViewerAccessList } from '@lookup/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { findAccessibilityProblems } from '../../test/accessibility';
import { errorResponse, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';
import { describeClientAccess } from './client-access-dialog';

const person = userEvent.setup({ delay: null });
const owner = signedInUserWith([{ role: 'OWNER' }]);
const analyst = signedInUserWith([{ role: 'ANALYST' }]);
const stationId = owner.stations[0]?.id as string;
const clientsPath = `/stations/${stationId}/clients`;
const brandA: ClientListItem = { id: '0190f1a2-0000-7000-8000-0000000000a1', name: 'Brand A', adCount: 3, liveNowAdCount: 0, viewerCount: 1, pendingInvitationCount: 2 };
const viewersPath = `/stations/${stationId}/clients/${brandA.id}/viewers`;
const DAY = 86_400_000;

function accessList(changes: Partial<ClientViewerAccessList> = {}): ClientViewerAccessList {
  return {
    clientId: brandA.id,
    clientName: 'Brand A',
    people: [{ portalUserId: '0190f1a2-0000-7000-8000-0000000000f1', fullName: 'Chipo Banda', email: 'chipo@brand-a.example', joinedAt: '2026-10-20T08:00:00.000Z' }],
    pendingInvitations: [
      { id: '0190f1a2-0000-7000-8000-0000000000e1', email: 'mutale@brand-a.example', invitedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5.5 * DAY).toISOString(), isExpired: false },
      { id: '0190f1a2-0000-7000-8000-0000000000e2', email: 'old@brand-a.example', invitedAt: '2026-10-01T08:00:00.000Z', expiresAt: '2026-10-08T08:00:00.000Z', isExpired: true },
    ],
    canManage: true,
    ...changes,
  };
}

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('who can see a client’s ads (the station)', () => {
  it.each([
    [0, 0, 'Nobody can see their ads yet'],
    [0, 1, '1 invitation waiting'],
    [1, 0, '1 person can see their ads'],
    [3, 2, '3 people can see their ads · 2 invitations waiting'],
  ])('P5C-ONBOARDING-02: a client row with %i people and %i invitations says "%s"', (viewerCount, pendingInvitationCount, words) => {
    expect(describeClientAccess({ viewerCount, pendingInvitationCount })).toBe(words);
  });

  it('P5C-ONBOARDING-02, P5C-ONBOARDING-04: Manage access lists the people and the invitations; an owner invites, sends again and cancels in the Team page’s words', async () => {
    let current = accessList();
    const api = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET ${clientsPath}`]: () => jsonResponse(200, [brandA]),
      [`GET ${viewersPath}`]: () => jsonResponse(200, current),
      [`POST ${viewersPath}/invitations`]: () => {
        current = accessList({ pendingInvitations: [...current.pendingInvitations, { id: '0190f1a2-0000-7000-8000-0000000000e3', email: 'new@brand-a.example', invitedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * DAY).toISOString(), isExpired: false }] });
        return jsonResponse(201, current);
      },
      [`POST ${viewersPath}/invitations/0190f1a2-0000-7000-8000-0000000000e2/resending`]: () => jsonResponse(200, current),
      [`POST ${viewersPath}/invitations/0190f1a2-0000-7000-8000-0000000000e1/revocation`]: () => {
        current = accessList({ pendingInvitations: current.pendingInvitations.filter((invitation) => invitation.id !== '0190f1a2-0000-7000-8000-0000000000e1') });
        return jsonResponse(200, current);
      },
    });
    renderPortalAt(clientsPath);
    expect(await screen.findByText('1 person can see their ads · 2 invitations waiting')).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: "Manage who can see Brand A's ads" }));

    const dialog = await screen.findByRole('dialog', { name: "Who can see Brand A's ads" });
    expect(await within(dialog).findByText('Chipo Banda')).toBeInTheDocument();
    expect(within(dialog).getByText('chipo@brand-a.example · Joined 20 Oct')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Pending invitations' })).toBeInTheDocument();
    expect(within(dialog).getByText('Expires in 5 days')).toBeInTheDocument();
    expect(within(dialog).getByText('Expired')).toBeInTheDocument();
    expect(await findAccessibilityProblems()).toEqual([]);

    await person.type(within(dialog).getByLabelText('Email'), 'new@brand-a.example');
    await person.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByText('Invitation sent. It works once and lasts 7 days.')).toBeInTheDocument();
    expect(api.calls.find((call) => call.path === `${viewersPath}/invitations`)?.body).toEqual({ email: 'new@brand-a.example' });
    expect(within(dialog).getByText('new@brand-a.example')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Email')).toHaveValue('');

    await person.click(within(dialog).getByRole('button', { name: 'Send again: old@brand-a.example' }));
    expect(await within(dialog).findByText('Invitation sent again. The new link works once and lasts 7 days; the old one no longer works.')).toBeInTheDocument();
    await person.click(within(dialog).getByRole('button', { name: 'Cancel invitation: mutale@brand-a.example' }));
    await waitFor(() => expect(within(dialog).queryByText('mutale@brand-a.example')).not.toBeInTheDocument());
  });

  it('P5C-ONBOARDING-02: Remove access asks first, then removes; Keep access changes nothing', async () => {
    let current = accessList();
    const api = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET ${clientsPath}`]: () => jsonResponse(200, [brandA]),
      [`GET ${viewersPath}`]: () => jsonResponse(200, current),
      [`DELETE ${viewersPath}/0190f1a2-0000-7000-8000-0000000000f1`]: () => {
        current = accessList({ people: [] });
        return jsonResponse(200, current);
      },
    });
    renderPortalAt(clientsPath);
    await person.click(await screen.findByRole('button', { name: "Manage who can see Brand A's ads" }));
    const dialog = await screen.findByRole('dialog', { name: "Who can see Brand A's ads" });
    await person.click(await within(dialog).findByRole('button', { name: 'Remove access: Chipo Banda' }));
    const question = within(dialog).getByRole('group', { name: "Remove Chipo Banda's access?" });
    await person.click(within(question).getByRole('button', { name: 'Keep access' }));
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false);

    await person.click(within(dialog).getByRole('button', { name: 'Remove access: Chipo Banda' }));
    await person.click(within(within(dialog).getByRole('group', { name: "Remove Chipo Banda's access?" })).getByRole('button', { name: 'Remove access' }));
    expect(await within(dialog).findByText('Nobody yet.')).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  it('P5C-ONBOARDING-02: an analyst sees who can see the ads, without any button that changes it', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, analyst),
      [`GET ${clientsPath}`]: () => jsonResponse(200, [brandA]),
      [`GET ${viewersPath}`]: () => jsonResponse(200, accessList({ canManage: false })),
    });
    renderPortalAt(clientsPath);
    await person.click(await screen.findByRole('button', { name: "Manage who can see Brand A's ads" }));
    const dialog = await screen.findByRole('dialog', { name: "Who can see Brand A's ads" });
    expect(await within(dialog).findByText('Chipo Banda')).toBeInTheDocument();
    for (const name of [/Remove access/, /Send again/, /Cancel invitation/, /Send invitation/]) expect(within(dialog).queryByRole('button', { name })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Email')).not.toBeInTheDocument();
    expect(await findAccessibilityProblems()).toEqual([]);
  });

  it('P5C-ONBOARDING-05: an email that can already see the ads is refused in the server’s own words', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET ${clientsPath}`]: () => jsonResponse(200, [brandA]),
      [`GET ${viewersPath}`]: () => jsonResponse(200, accessList()),
      [`POST ${viewersPath}/invitations`]: () => errorResponse(409, 'CLIENT_VIEWER_ALREADY_HAS_ACCESS', "This person can already view this client's ads."),
    });
    renderPortalAt(clientsPath);
    await person.click(await screen.findByRole('button', { name: "Manage who can see Brand A's ads" }));
    const dialog = await screen.findByRole('dialog', { name: "Who can see Brand A's ads" });
    await person.type(await within(dialog).findByLabelText('Email'), 'chipo@brand-a.example');
    await person.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByText("This person can already view this client's ads.")).toBeInTheDocument();
  });
});

describe('adding a client with an email (the station)', () => {
  it('P5C-ONBOARDING-01: the client is added and invited in one step, and the toast says so', async () => {
    const api = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET ${clientsPath}`]: () => jsonResponse(200, []),
      [`POST ${clientsPath}`]: () => jsonResponse(201, { id: brandA.id, name: 'Brand A', invitedEmail: 'chipo@brand-a.example' }),
    });
    renderPortalAt(clientsPath);
    await person.type(await screen.findByLabelText('Add a client'), 'Brand A');
    expect(screen.getByRole('button', { name: 'Add client' })).toBeInTheDocument();
    await person.type(screen.getByLabelText("Client's email (optional)"), 'chipo@brand-a.example');
    await person.click(screen.getByRole('button', { name: 'Add client and invite' }));
    expect(await screen.findByText('Brand A added. Invitation sent to chipo@brand-a.example.')).toBeInTheDocument();
    expect(api.calls.find((call) => call.method === 'POST')?.body).toEqual({ name: 'Brand A', email: 'chipo@brand-a.example' });
  });

  it('P5C-ONBOARDING-01: without an email only the name is sent; a refused email is shown under the email and nothing is added', async () => {
    const api = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET ${clientsPath}`]: () => jsonResponse(200, []),
      [`POST ${clientsPath}`]: (body) =>
        (body as { email?: string }).email
          ? errorResponse(400, 'VALIDATION_FAILED', 'Some details are missing or not valid.', 'r1', [{ path: 'email', code: 'invalid_format' }])
          : jsonResponse(201, { id: brandA.id, name: 'Brand A', invitedEmail: null }),
    });
    renderPortalAt(clientsPath);
    await person.type(await screen.findByLabelText('Add a client'), 'Brand A');
    await person.type(screen.getByLabelText("Client's email (optional)"), 'not an email');
    await person.click(screen.getByRole('button', { name: 'Add client and invite' }));
    expect(await screen.findByText('Enter an email address, or leave it empty.')).toBeInTheDocument();
    expect(screen.getByLabelText('Add a client')).toHaveValue('Brand A');

    await person.clear(screen.getByLabelText("Client's email (optional)"));
    await person.click(screen.getByRole('button', { name: 'Add client' }));
    expect(await screen.findByText('Brand A added')).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === 'POST').at(-1)?.body).toEqual({ name: 'Brand A' });
  });
});
