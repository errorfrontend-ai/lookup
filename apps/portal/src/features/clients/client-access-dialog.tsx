import type { ClientListItem, ClientViewerAccessList, InviteClientViewerInput } from '@lookup/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../../api/api-client';
import { portalApi } from '../../app/portal-api';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { ModalDialog } from '../../components/modal-dialog';
import { SkeletonRows } from '../../components/skeleton';
import { TextField } from '../../components/text-field';
import { formatStationDate } from '../../formatting/describe-schedule';
import { stationQueryKeys } from '../stations/station-query-keys';
import { expiryWords } from '../team/team-page';

/** Who can see a client's ads, in the clients list's own words (P5C-ONBOARDING-02). */
export function describeClientAccess(client: Pick<ClientListItem, 'viewerCount' | 'pendingInvitationCount'>): string {
  const waiting = client.pendingInvitationCount === 1 ? '1 invitation waiting' : `${client.pendingInvitationCount} invitations waiting`;
  if (client.viewerCount === 0) return client.pendingInvitationCount === 0 ? 'Nobody can see their ads yet' : waiting;
  const people = client.viewerCount === 1 ? '1 person can see their ads' : `${client.viewerCount} people can see their ads`;
  return client.pendingInvitationCount === 0 ? people : `${people} · ${waiting}`;
}

const viewersKey = (stationId: string, clientId: string) => [...stationQueryKeys.clients(stationId), clientId, 'viewers'] as const;

/**
 * "Manage access" for one client (ADR-006; P5C-ONBOARDING-02, -04): the people who can see the client's adverts, the
 * invitations waiting, and Invite someone, in the Team page's words so a station recognises it. Owners and managers change
 * it; analysts see the lists only.
 */
export function ClientAccessDialog({ stationId, client, onClose }: { stationId: string; client: Pick<ClientListItem, 'id' | 'name'>; onClose: () => void }) {
  const queryClient = useQueryClient();
  const queryKey = viewersKey(stationId, client.id);
  const basePath = `/stations/${stationId}/clients/${client.id}/viewers`;
  const access = useQuery({ queryKey, queryFn: () => portalApi.get<ClientViewerAccessList>(basePath) });
  const [email, setEmail] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);
  const keep = (saved: ClientViewerAccessList) => {
    queryClient.setQueryData(queryKey, saved);
    // The clients list counts who can see each client's ads.
    void queryClient.invalidateQueries({ queryKey: stationQueryKeys.clients(stationId), exact: true });
  };
  const invite = useMutation({
    mutationFn: (input: InviteClientViewerInput) => portalApi.post<ClientViewerAccessList>(`${basePath}/invitations`, input),
    onSuccess: (saved) => {
      keep(saved);
      setEmail('');
    },
  });
  const resend = useMutation({ mutationFn: (invitationId: string) => portalApi.post<ClientViewerAccessList>(`${basePath}/invitations/${invitationId}/resending`), onSuccess: keep });
  const cancel = useMutation({ mutationFn: (invitationId: string) => portalApi.post<ClientViewerAccessList>(`${basePath}/invitations/${invitationId}/revocation`), onSuccess: keep });
  const remove = useMutation({
    mutationFn: (portalUserId: string) => portalApi.delete<ClientViewerAccessList>(`${basePath}/${portalUserId}`),
    onSuccess: (saved) => {
      keep(saved);
      setRemovingId(null);
    },
  });
  const inviteError = invite.error instanceof ApiError && invite.error.fields.some((field) => field.path === 'email') ? 'Enter an email address.' : null;

  const submitInvite = (event: FormEvent) => {
    event.preventDefault();
    if (email.trim()) invite.mutate({ email: email.trim() });
  };

  return (
    <ModalDialog title={`Who can see ${client.name}'s ads`} onClose={onClose}>
      <p className="text-body text-muted">{`They see ${client.name}'s adverts on this station: when they air and how listeners respond. They can't change anything.`}</p>
      {access.isPending ? <SkeletonRows count={2} rowClassName="h-14" /> : null}
      {access.isError ? <ErrorNotice error={access.error} title="We couldn't load who can see these ads" /> : null}
      {access.data ? (
        <div className="flex max-h-[60dvh] flex-col gap-5 overflow-y-auto">
          <section aria-labelledby="client-access-people" className="flex flex-col gap-2">
            <h3 id="client-access-people" className="text-label">
              People with access
            </h3>
            {access.data.people.length === 0 ? <p className="text-body text-muted">Nobody yet.</p> : null}
            <ul className="flex flex-col gap-2">
              {access.data.people.map((person) => (
                <li key={person.portalUserId} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="text-label">{person.fullName}</span>
                    <span className="truncate text-caption text-muted">
                      {person.email} · Joined {formatStationDate(person.joinedAt.slice(0, 10))}
                    </span>
                  </div>
                  {access.data.canManage && removingId !== person.portalUserId ? (
                    <Button variant="quiet" className="self-start" onClick={() => setRemovingId(person.portalUserId)}>
                      Remove access<span className="sr-only">: {person.fullName}</span>
                    </Button>
                  ) : null}
                  {removingId === person.portalUserId ? (
                    <div role="group" aria-label={`Remove ${person.fullName}'s access?`} className="flex flex-col gap-2 rounded-md bg-danger-soft p-3">
                      <span className="text-body">{`Remove ${person.fullName}'s access? They stop seeing ${client.name}'s ads straight away. You can invite them again later.`}</span>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="danger" isBusy={remove.isPending} busyLabel="Removing…" onClick={() => remove.mutate(person.portalUserId)}>
                          Remove access
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setRemovingId(null);
                            remove.reset();
                          }}
                        >
                          Keep access
                        </Button>
                      </div>
                      {remove.isError ? <ErrorNotice error={remove.error} /> : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="client-access-invitations" className="flex flex-col gap-2">
            <h3 id="client-access-invitations" className="text-label">
              Pending invitations
            </h3>
            {access.data.pendingInvitations.length === 0 ? <p className="text-body text-muted">No invitations waiting.</p> : null}
            <ul className="flex flex-col gap-2">
              {access.data.pendingInvitations.map((invitation) => (
                <li key={invitation.id} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-label">{invitation.email}</span>
                    <span className={`text-caption ${invitation.isExpired ? 'text-danger' : 'text-muted'}`}>{invitation.isExpired ? 'Expired' : expiryWords(invitation.expiresAt)}</span>
                  </div>
                  {access.data.canManage ? (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={() => resend.mutate(invitation.id)} isBusy={resend.isPending && resend.variables === invitation.id} busyLabel="Sending…">
                        Send again<span className="sr-only">: {invitation.email}</span>
                      </Button>
                      <Button variant="quiet" onClick={() => cancel.mutate(invitation.id)} isBusy={cancel.isPending && cancel.variables === invitation.id} busyLabel="Cancelling…">
                        Cancel invitation<span className="sr-only">: {invitation.email}</span>
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {resend.isSuccess ? (
              <p role="status" className="text-body">
                Invitation sent again. The new link works once and lasts 7 days; the old one no longer works.
              </p>
            ) : null}
            {resend.isError ? <ErrorNotice error={resend.error} /> : null}
            {cancel.isError ? <ErrorNotice error={cancel.error} /> : null}
          </section>

          {access.data.canManage ? (
            <section aria-labelledby="client-access-invite" className="flex flex-col gap-3">
              <h3 id="client-access-invite" className="text-label">
                Invite someone
              </h3>
              <form onSubmit={submitInvite} noValidate className="flex flex-col gap-3">
                <TextField
                  label="Email"
                  hint={`Someone at ${client.name}. They get a link to make an account or sign in.`}
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  maxLength={254}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  error={inviteError}
                />
                {invite.isError && !inviteError ? <ErrorNotice error={invite.error} /> : null}
                {invite.isSuccess ? (
                  <p role="status" className="text-body">
                    Invitation sent. It works once and lasts 7 days.
                  </p>
                ) : null}
                <Button type="submit" className="self-start" disabled={!email.trim()} isBusy={invite.isPending} busyLabel="Sending…">
                  Send invitation
                </Button>
              </form>
            </section>
          ) : null}
        </div>
      ) : null}
    </ModalDialog>
  );
}
