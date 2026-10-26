import type { StationChangeRequestState, StationTeam } from '@lookup/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { findAccessibilityProblems } from '../../test/accessibility';
import { errorResponse, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';
import { changeSummary } from '../stations/station-change-section';
import { readInvitationToken } from './invitation-page';
import { expiryWords } from './team-page';

const person = userEvent.setup({ delay: null });
const owner = signedInUserWith([{ role: 'OWNER', name: 'Radio Phoenix', frequencyLabel: '89.5 FM' }]);
const stationId = owner.stations[0]?.id as string;
const ownerId = owner.user.id;
const managerId = '0190f1a2-0000-7000-8000-0000000000b2';

function teamWith(overrides: Partial<StationTeam> = {}): StationTeam {
  return {
    members: [
      { portalUserId: ownerId, fullName: 'Chanda Mwale', email: 'chanda@example.test', role: 'OWNER', isYou: true },
      { portalUserId: managerId, fullName: 'Bwalya Phiri', email: 'bwalya@example.test', role: 'MANAGER', isYou: false },
    ],
    pendingInvitations: [{ id: '0190f1a2-0000-7000-8000-0000000000f1', email: 'new@example.test', role: 'ANALYST', invitedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5.5 * 86_400_000).toISOString() }],
    canManage: true,
    ...overrides,
  };
}
const approved: StationChangeRequestState = { approved: { name: 'Radio Phoenix', frequencyLabel: '89.5 FM', licenceNumber: 'IBA/2026/0001' }, open: null, lastDecided: null };

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('Team', () => {
  it('journey F: an owner sees the members and invitations, invites with a role, cancels an invitation and removes a member after confirming', async () => {
    let team = teamWith();
    const api = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}/members`]: () => jsonResponse(200, team),
      [`POST /stations/${stationId}/invitations`]: () => jsonResponse(201, team),
      [`POST /stations/${stationId}/invitations/0190f1a2-0000-7000-8000-0000000000f1/revocation`]: () => {
        team = teamWith({ pendingInvitations: [] });
        return jsonResponse(200, team);
      },
      [`DELETE /stations/${stationId}/members/${managerId}`]: () => {
        team = teamWith({ members: teamWith().members.slice(0, 1), pendingInvitations: [] });
        return jsonResponse(200, team);
      },
    });
    renderPortalAt(`/stations/${stationId}/team`);
    expect(await screen.findByRole('heading', { name: 'Team' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Team/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Analyst · Expires in 5 days')).toBeInTheDocument();

    await person.type(screen.getByLabelText('Email'), 'someone@example.test');
    await person.click(screen.getByRole('radio', { name: /Analyst/ }));
    expect(screen.getByText("Can look, can't change anything")).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Invitation sent. It works once and lasts 7 days.')).toBeInTheDocument();
    expect(api.calls.find((call) => call.path.endsWith('/invitations'))?.body).toEqual({ email: 'someone@example.test', role: 'ANALYST' });

    await person.click(screen.getByRole('button', { name: 'Cancel invitation: new@example.test' }));
    expect(await screen.findByText('No invitations waiting.')).toBeInTheDocument();

    await person.click(screen.getByRole('button', { name: 'Remove from team: Bwalya Phiri' }));
    const dialog = screen.getByRole('dialog');
    await person.click(within(dialog).getByRole('button', { name: 'Remove from team' }));
    await waitFor(() => expect(screen.queryByText('Bwalya Phiri')).not.toBeInTheDocument());
  });

  it('the last owner cannot be removed, and says why; others see the lists without controls', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}/members`]: () => jsonResponse(200, teamWith()),
      [`DELETE /stations/${stationId}/members/${ownerId}`]: () => errorResponse(409, 'LAST_OWNER', 'A station needs at least one owner. Invite another owner first.'),
    });
    renderPortalAt(`/stations/${stationId}/team`);
    await person.click(await screen.findByRole('button', { name: 'Remove from team: Chanda Mwale' }));
    await person.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove from team' }));
    expect(await screen.findByText('A station needs at least one owner. Invite another owner first.')).toBeInTheDocument();
  });

  it('a manager sees the team but no invite or remove controls', async () => {
    const manager = signedInUserWith([{ id: stationId, role: 'MANAGER' }]);
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, manager), [`GET /stations/${stationId}/members`]: () => jsonResponse(200, teamWith({ canManage: false })) });
    renderPortalAt(`/stations/${stationId}/team`);
    expect(await screen.findByText('Bwalya Phiri')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Invite someone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove from team/ })).not.toBeInTheDocument();
    expect(await findAccessibilityProblems()).toEqual([]);
  });
});

describe('accepting an invitation', () => {
  const token = 'C'.repeat(43);
  const open = { kind: 'STATION_MEMBER', state: 'OPEN', stationName: 'Radio Phoenix', frequencyLabel: '89.5 FM', role: 'MANAGER', clientName: null, invitedEmail: 'new@example.test', hasAccount: false, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };

  it('a new person joins with a new account and goes to the station', async () => {
    window.history.replaceState(null, '', `/invitations/accept#token=${token}`);
    const api = installFakeApi({
      'GET /auth/me': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /invitations/description': () => jsonResponse(200, open),
      'POST /invitations/acceptance-with-new-account': () => jsonResponse(201, { kind: 'STATION_MEMBER', stationId, clientId: null }),
    });
    const { router } = renderPortalAt('/invitations/accept');
    expect(await screen.findByRole('heading', { name: "You're invited to join Radio Phoenix · 89.5 FM as a Manager" })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    await person.type(screen.getByLabelText('Your full name'), 'Bwalya Phiri');
    await person.type(screen.getByLabelText('Password'), 'morning tide on the river bank');
    await person.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${stationId}/overview`));
    expect(api.calls.find((call) => call.path === '/invitations/acceptance-with-new-account')?.body).toEqual({
      token, fullName: 'Bwalya Phiri', mobileNumber: null, password: 'morning tide on the river bank',
    });
  });

  it('an email with an account is asked to sign in, and the token waits in this tab', async () => {
    window.history.replaceState(null, '', `/invitations/accept#token=${token}`);
    installFakeApi({
      'GET /auth/me': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /invitations/description': () => jsonResponse(200, { ...open, hasAccount: true }),
    });
    const { router } = renderPortalAt('/invitations/accept');
    await person.click(await screen.findByRole('button', { name: 'Sign in to accept' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(readInvitationToken()).toBe(token);
  });

  it('signed in with another email, "Sign out" leads back to the invitation once the invited email has signed in', async () => {
    window.history.replaceState(null, '', `/invitations/accept#token=${token}`);
    const someoneElse = { ...signedInUserWith([]), user: { id: '0190f1a2-0000-7000-8000-0000000000c8', fullName: 'Station Owner', email: 'owner@station-a.example', platformRole: null } };
    const invited = { ...signedInUserWith([]), user: { id: '0190f1a2-0000-7000-8000-0000000000c9', fullName: 'New Person', email: 'new@example.test', platformRole: null } };
    let current: typeof invited | null = someoneElse;
    installFakeApi({
      'GET /auth/me': () => (current ? jsonResponse(200, current) : errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.')),
      'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /auth/sign-out': () => {
        current = null;
        return jsonResponse(204, null);
      },
      'POST /auth/sign-in': () => {
        current = invited;
        return jsonResponse(200, invited);
      },
      'POST /invitations/description': () => jsonResponse(200, { ...open, hasAccount: true }),
    });
    const { router } = renderPortalAt('/invitations/accept');
    expect(await screen.findByText('This invitation was sent to new@example.test. Sign out, then sign in with that email to accept.')).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    await person.type(await screen.findByLabelText('Email'), 'new@example.test');
    await person.type(screen.getByLabelText('Password'), 'amber kettle rainy harbour');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/invitations/accept'));
    expect(await screen.findByRole('button', { name: 'Join Radio Phoenix' })).toBeInTheDocument();
  });

  it('P5C-INVITATIONS-02, P5C-ONBOARDING-04: a client invitation uses the same page and steps, and lands on the client’s adverts', async () => {
    window.history.replaceState(null, '', `/invitations/accept#token=${token}`);
    const clientInvitation = { ...open, kind: 'CLIENT_VIEWER', role: null, clientName: 'Brand A', invitedEmail: 'chipo@brand-a.example' };
    const api = installFakeApi({
      'GET /auth/me': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /invitations/description': () => jsonResponse(200, clientInvitation),
      'POST /invitations/acceptance-with-new-account': () => jsonResponse(201, { kind: 'CLIENT_VIEWER', stationId, clientId: '0190f1a2-0000-7000-8000-0000000000a1' }),
    });
    const { router } = renderPortalAt('/invitations/accept');
    expect(await screen.findByRole('heading', { name: "Radio Phoenix · 89.5 FM invites you to view Brand A's adverts" })).toBeInTheDocument();
    expect(screen.getByText(/You can view everything; only the station can change it\./)).toBeInTheDocument();
    expect(screen.getByText('Your account will use chipo@brand-a.example.')).toBeInTheDocument();
    await person.type(screen.getByLabelText('Your full name'), 'Chipo Banda');
    await person.type(screen.getByLabelText('Password'), 'morning tide on the river bank');
    await person.click(screen.getByRole('button', { name: 'Create account and accept' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/client'));
    expect(api.calls.find((call) => call.path === '/invitations/acceptance-with-new-account')?.body).toEqual({
      token, fullName: 'Chipo Banda', mobileNumber: null, password: 'morning tide on the river bank',
    });
  });

  it('P5C-ONBOARDING-03: a client invitation to an email with an account is accepted by signing in, with the same words', async () => {
    window.history.replaceState(null, '', `/invitations/accept#token=${token}`);
    const signedInClient = { ...signedInUserWith([]), user: { id: '0190f1a2-0000-7000-8000-0000000000c9', fullName: 'Chipo Banda', email: 'chipo@brand-a.example', platformRole: null } };
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, signedInClient),
      'POST /invitations/description': () => jsonResponse(200, { ...open, kind: 'CLIENT_VIEWER', role: null, clientName: 'Brand A', invitedEmail: 'chipo@brand-a.example', hasAccount: true }),
      'POST /invitations/acceptance': () => jsonResponse(200, { kind: 'CLIENT_VIEWER', stationId, clientId: '0190f1a2-0000-7000-8000-0000000000a1' }),
    });
    const { router } = renderPortalAt('/invitations/accept');
    await person.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/client'));
  });

  it('an expired invitation says so', async () => {
    window.history.replaceState(null, '', `/invitations/accept#token=${token}`);
    installFakeApi({
      'GET /auth/me': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
      'POST /invitations/description': () => jsonResponse(200, { ...open, state: 'EXPIRED' }),
    });
    renderPortalAt('/invitations/accept');
    expect(await screen.findByText("This invitation has expired. Ask the station's owner for a new one.")).toBeInTheDocument();
  });
});

describe('asking to change the name, frequency or licence (O2)', () => {
  it('an owner asks; the station keeps its name until review; a waiting change can be withdrawn', async () => {
    let state = approved;
    const api = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}`]: () => jsonResponse(200, { id: stationId, name: 'Radio Phoenix', frequencyLabel: '89.5 FM', province: 'Lusaka', city: 'Lusaka', timeZone: 'Africa/Lusaka', status: 'ACTIVE', isListedInApp: true, yourRole: 'OWNER' }),
      [`GET /stations/${stationId}/change-request`]: () => jsonResponse(200, state),
      [`POST /stations/${stationId}/change-requests`]: () => {
        state = { ...approved, open: { id: 'r', requestedAt: new Date().toISOString(), name: 'Phoenix FM', frequencyLabel: '89.5 FM', licenceNumber: 'IBA/2026/0001', hasNewLicenceDocument: false, decision: null, decisionNote: null, decidedAt: null } };
        return jsonResponse(201, state);
      },
      [`POST /stations/${stationId}/change-request/withdrawal`]: () => {
        state = approved;
        return jsonResponse(200, state);
      },
    });
    renderPortalAt(`/stations/${stationId}/profile`);
    await person.click(await screen.findByRole('button', { name: 'Ask to change these' }));
    expect(screen.getByText('We check these changes before they show. Until then your station keeps its current name and frequency.')).toBeInTheDocument();
    const name = screen.getByLabelText('Station name');
    await person.clear(name);
    await person.type(name, 'Phoenix FM');
    await person.click(screen.getByRole('button', { name: 'Send for review' }));
    expect(await screen.findByText('Waiting for review: name to Phoenix FM.')).toBeInTheDocument();
    expect(api.calls.find((call) => call.path.endsWith('/change-requests'))?.body).toEqual({ name: 'Phoenix FM', frequencyLabel: '89.5 FM', licenceNumber: 'IBA/2026/0001', licenceDocumentUploadId: null });
    await person.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByRole('button', { name: 'Ask to change these' })).toBeInTheDocument();
  });

  it('a refused change shows the reviewer\'s words', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}`]: () => jsonResponse(200, { id: stationId, name: 'Radio Phoenix', frequencyLabel: '89.5 FM', province: null, city: null, timeZone: 'Africa/Lusaka', status: 'ACTIVE', isListedInApp: true, yourRole: 'OWNER' }),
      [`GET /stations/${stationId}/change-request`]: () =>
        jsonResponse(200, { ...approved, lastDecided: { id: 'r', requestedAt: new Date().toISOString(), name: 'X FM', frequencyLabel: '89.5 FM', licenceNumber: 'L', hasNewLicenceDocument: false, decision: 'REJECTED', decisionNote: 'That name belongs to another station.', decidedAt: new Date().toISOString() } }),
    });
    renderPortalAt(`/stations/${stationId}/profile`);
    expect(await screen.findByText('Not approved: That name belongs to another station.')).toBeInTheDocument();
  });
});

describe('the rules behind the pages', () => {
  it('says when an invitation expires, and what a change asks for', () => {
    expect(expiryWords(new Date(Date.now() + 5.5 * 86_400_000).toISOString())).toBe('Expires in 5 days');
    expect(expiryWords(new Date(Date.now() + 1.2 * 86_400_000).toISOString())).toBe('Expires tomorrow');
    expect(expiryWords(new Date(Date.now() + 3_600_000).toISOString())).toBe('Expires today');
    expect(changeSummary(approved.approved, { id: 'r', requestedAt: '', name: 'Radio Phoenix', frequencyLabel: '90.1 FM', licenceNumber: 'IBA/2026/0001', hasNewLicenceDocument: true, decision: null, decisionNote: null, decidedAt: null })).toBe(
      'frequency to 90.1 FM, a new licence document',
    );
  });
});
