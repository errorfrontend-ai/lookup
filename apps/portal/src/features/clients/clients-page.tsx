import { type ClientListItem, MAXIMUM_CLIENT_NAME_LENGTH } from '@lookup/contracts';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ClientAvatar } from '../../components/client-avatar';
import { EmptyState } from '../../components/empty-state';
import { ErrorNotice } from '../../components/error-notice';
import { PageHeader } from '../../components/page-header';
import { SkeletonRows } from '../../components/skeleton';
import { OnAirBadge } from '../../components/status-badges';
import { TextField } from '../../components/text-field';
import { useToast } from '../../components/toast-region';
import { canChangeStationContent, useRequiredCurrentStation } from '../stations/use-current-station';
import { ClientAccessDialog, describeClientAccess } from './client-access-dialog';
import { useClients, useCreateClient } from './use-clients';
import { browserMaxLength } from '../../formatting/text-length';

/** How many ads a client has, in words. */
export function describeClientAdCount(adCount: number): string {
  if (adCount === 0) return 'No ads yet';
  return adCount === 1 ? '1 ad' : `${adCount} ads`;
}

/** The words for a refused "add client": the server's own sentence for a duplicate, our own for a bad name or email. */
function addClientProblems(error: unknown): { name: string | null; email: string | null } {
  if (!(error instanceof ApiError)) return { name: null, email: null };
  if (error.code === 'CONFLICT') return { name: error.message, email: null };
  if (error.code !== 'VALIDATION_FAILED') return { name: null, email: null };
  const isEmail = error.fields.some((field) => field.path === 'email');
  const isName = error.fields.some((field) => field.path === 'name') || !isEmail;
  return {
    name: isName ? `Enter a name between 1 and ${MAXIMUM_CLIENT_NAME_LENGTH} characters.` : null,
    email: isEmail ? 'Enter an email address, or leave it empty.' : null,
  };
}

/**
 * "Add a client", with the client's email if the station has it (P5C-ONBOARDING-01): the client is added and invited to see
 * their ads in one step. A refused invitation adds no client.
 */
function AddClientForm({ stationId }: { stationId: string }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const createClient = useCreateClient(stationId);
  const showToast = useToast();
  const problems = addClientProblems(createClient.error);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) return;
    createClient.mutate(trimmedEmail ? { name: trimmedName, email: trimmedEmail } : { name: trimmedName }, {
      onSuccess: (created) => {
        setName('');
        setEmail('');
        showToast(created.invitedEmail ? `${trimmedName} added. Invitation sent to ${created.invitedEmail}.` : `${trimmedName} added`);
      },
    });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-4">
      <div className="grid items-start gap-3 md:grid-cols-2">
        <TextField
          label="Add a client"
          hint="The business you upload ads for, like “Brand A”."
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={browserMaxLength(MAXIMUM_CLIENT_NAME_LENGTH)}
          counter={`${[...name].length} / ${MAXIMUM_CLIENT_NAME_LENGTH}`}
          error={problems.name}
          autoComplete="off"
        />
        <TextField
          label="Client's email (optional)"
          hint="We invite them to see their ads, when they air and how listeners respond. They can't change anything."
          type="email"
          inputMode="email"
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={problems.email}
          autoComplete="off"
        />
      </div>
      <Button type="submit" className="self-start" isBusy={createClient.isPending} busyLabel="Adding…" disabled={!name.trim()}>
        {email.trim() ? 'Add client and invite' : 'Add client'}
      </Button>
      {createClient.isError && !problems.name && !problems.email ? <ErrorNotice error={createClient.error} /> : null}
    </form>
  );
}

export function ClientsPage() {
  const station = useRequiredCurrentStation();
  const clients = useClients(station.id);
  const canAddClients = canChangeStationContent(station);
  const [managing, setManaging] = useState<ClientListItem | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Clients" description="The businesses you upload ads for. Each ad belongs to one client." />

      {canAddClients ? <AddClientForm stationId={station.id} /> : null}

      {clients.isPending ? <SkeletonRows count={4} /> : null}
      {clients.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice error={clients.error} title="We couldn't load your clients" />
          <Button variant="secondary" onClick={() => void clients.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      {clients.isSuccess && clients.data.length === 0 ? (
        <EmptyState icon="clients" title="No clients yet">
          {canAddClients ? 'Add your first client above, then upload their ads.' : 'Clients appear here once an owner or manager adds them.'}
        </EmptyState>
      ) : null}
      {clients.isSuccess && clients.data.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {clients.data.map((clientItem) => (
            <li key={clientItem.id} className="flex items-center gap-4 rounded-lg border border-line-soft bg-surface p-4">
              <ClientAvatar clientId={clientItem.id} name={clientItem.name} size="lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-heading">{clientItem.name}</span>
                <span className="flex flex-wrap items-center gap-2 text-label text-muted">
                  {describeClientAdCount(clientItem.adCount)}
                  {clientItem.liveNowAdCount > 0 ? <OnAirBadge /> : null}
                </span>
                <span className="text-caption text-muted">{describeClientAccess(clientItem)}</span>
              </div>
              <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center">
                {clientItem.adCount > 0 ? (
                  <Link
                    to={`/stations/${station.id}/ads?client=${clientItem.id}`}
                    className="flex min-h-11 items-center rounded-md px-3 text-label text-accent hover:bg-accent-soft"
                    aria-label={`See ${clientItem.name}'s ads`}
                  >
                    See ads
                  </Link>
                ) : null}
                <button
                  type="button"
                  onClick={() => setManaging(clientItem)}
                  className="flex min-h-11 items-center rounded-md px-3 text-label text-accent hover:bg-accent-soft"
                  aria-label={`Manage who can see ${clientItem.name}'s ads`}
                >
                  Manage access
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {managing ? <ClientAccessDialog stationId={station.id} client={managing} onClose={() => setManaging(null)} /> : null}
    </div>
  );
}
