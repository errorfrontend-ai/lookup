import { type InviteStationMemberInput, STATION_ROLES, type StationRole, type StationTeam } from '@lookup/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { portalApi } from '../../app/portal-api';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { ConfirmDialog } from '../../components/modal-dialog';
import { TextField } from '../../components/text-field';
import { useRequiredCurrentStation } from '../stations/use-current-station';

/** Each role, with what it may do (P5A design §4.5). */
export const ROLE_CHOICES: Record<StationRole, { name: string; explanation: string }> = {
  OWNER: { name: 'Owner', explanation: 'Everything, including the team' },
  MANAGER: { name: 'Manager', explanation: 'Ads, clients and the station profile' },
  ANALYST: { name: 'Analyst', explanation: "Can look, can't change anything" },
};

/** "Expires in 5 days", "Expires tomorrow", "Expires today". */
export function expiryWords(isoTime: string, now = Date.now()): string {
  const days = Math.floor((Date.parse(isoTime) - now) / 86_400_000);
  if (days <= 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  return `Expires in ${days} days`;
}

/**
 * Team (P5A design §4.5; journey F; P5A-TEAM-*): the members and the open invitations for everyone; for an owner of
 * an approved station, "Invite someone" (email and a role), "Cancel invitation" and "Remove from team".
 */
export function TeamPage() {
  const station = useRequiredCurrentStation();
  const queryClient = useQueryClient();
  const queryKey = ['stations', station.id, 'team'] as const;
  const team = useQuery({ queryKey, queryFn: () => portalApi.get<StationTeam>(`/stations/${station.id}/members`) });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StationRole>('MANAGER');
  const [removing, setRemoving] = useState<StationTeam['members'][number] | null>(null);
  const keep = (saved: StationTeam) => queryClient.setQueryData(queryKey, saved);
  const invite = useMutation({
    mutationFn: (input: InviteStationMemberInput) => portalApi.post<StationTeam>(`/stations/${station.id}/invitations`, input),
    onSuccess: (saved) => {
      keep(saved);
      setEmail('');
    },
  });
  const cancel = useMutation({
    mutationFn: (invitationId: string) => portalApi.post<StationTeam>(`/stations/${station.id}/invitations/${invitationId}/revocation`),
    onSuccess: keep,
  });
  const remove = useMutation({
    mutationFn: (portalUserId: string) => portalApi.delete<StationTeam>(`/stations/${station.id}/members/${portalUserId}`),
    onSuccess: (saved) => {
      keep(saved);
      setRemoving(null);
    },
  });

  if (team.isPending) return <p className="text-body text-muted">Loading the team…</p>;
  if (team.isError) return <ErrorNotice error={team.error} title="We couldn't load the team" />;
  const { members, pendingInvitations, canManage } = team.data;
  const inviteError = invite.error instanceof ApiError && invite.error.fields.some((field) => field.path === 'email') ? 'Enter an email address.' : null;

  const submitInvite = (event: FormEvent) => {
    event.preventDefault();
    if (email.trim()) invite.mutate({ email: email.trim(), role });
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-display">Team</h1>
      <section aria-labelledby="team-members" className="flex flex-col gap-2">
        <h2 id="team-members" className="text-title">
          Members
        </h2>
        <ul className="flex flex-col gap-2">
          {members.map((member) => (
            <li key={member.portalUserId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface p-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-label">
                  {member.fullName}
                  {member.isYou ? <span className="ml-2 rounded-pill bg-ground px-2 text-caption">You</span> : null}
                </span>
                <span className="truncate text-caption text-muted">
                  {member.email} · {ROLE_CHOICES[member.role].name}
                </span>
              </div>
              {canManage ? (
                <Button variant="quiet" onClick={() => setRemoving(member)}>
                  Remove from team<span className="sr-only">: {member.fullName}</span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {remove.isError && !removing ? <ErrorNotice error={remove.error} /> : null}
      </section>

      <section aria-labelledby="team-invitations" className="flex flex-col gap-2">
        <h2 id="team-invitations" className="text-title">
          Pending invitations
        </h2>
        {pendingInvitations.length === 0 ? <p className="text-body text-muted">No invitations waiting.</p> : null}
        <ul className="flex flex-col gap-2">
          {pendingInvitations.map((invitation) => (
            <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface p-3">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-label">{invitation.email}</span>
                <span className="text-caption text-muted">
                  {ROLE_CHOICES[invitation.role].name} · {expiryWords(invitation.expiresAt)}
                </span>
              </div>
              {canManage ? (
                <Button variant="quiet" onClick={() => cancel.mutate(invitation.id)} isBusy={cancel.isPending && cancel.variables === invitation.id} busyLabel="Cancelling…">
                  Cancel invitation<span className="sr-only">: {invitation.email}</span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {cancel.isError ? <ErrorNotice error={cancel.error} /> : null}
      </section>

      {canManage ? (
        <section aria-labelledby="team-invite" className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 sm:p-6">
          <h2 id="team-invite" className="text-title">
            Invite someone
          </h2>
          <form onSubmit={submitInvite} noValidate className="flex flex-col gap-4">
            <TextField label="Email" type="email" inputMode="email" autoComplete="off" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} error={inviteError} />
            <fieldset className="flex flex-col gap-2">
              <legend className="text-label">Role</legend>
              {STATION_ROLES.map((choice) => (
                <label key={choice} className="flex min-h-11 items-start gap-3 rounded-md border border-line p-3">
                  <input type="radio" name="team-role" value={choice} checked={role === choice} onChange={() => setRole(choice)} className="mt-1 size-5" />
                  <span className="flex flex-col">
                    <span className="text-label">{ROLE_CHOICES[choice].name}</span>
                    <span className="text-caption text-muted">{ROLE_CHOICES[choice].explanation}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {invite.isError && !inviteError ? <ErrorNotice error={invite.error} /> : null}
            {invite.isSuccess ? <p role="status" className="text-body">Invitation sent. It works once and lasts 7 days.</p> : null}
            <Button type="submit" className="self-start" disabled={!email.trim()} isBusy={invite.isPending} busyLabel="Sending…">
              Send invitation
            </Button>
          </form>
        </section>
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.fullName} from the team?`}
          confirmLabel="Remove from team"
          isBusy={remove.isPending}
          onConfirm={() => remove.mutate(removing.portalUserId)}
          onClose={() => {
            setRemoving(null);
            remove.reset();
          }}
        >
          <p>They lose access to this station straight away. You can invite them again later.</p>
          {remove.isError ? <ErrorNotice error={remove.error} /> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
