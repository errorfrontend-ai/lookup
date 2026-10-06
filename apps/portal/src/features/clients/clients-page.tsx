import { MAXIMUM_CLIENT_NAME_LENGTH } from '@lookup/contracts';
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
import { useClients, useCreateClient } from './use-clients';

/** How many ads a client has, in words. */
export function describeClientAdCount(adCount: number): string {
  if (adCount === 0) return 'No ads yet';
  return adCount === 1 ? '1 ad' : `${adCount} ads`;
}

/** The words for a refused "add client": the server's own sentence for a duplicate, our own for a bad name. */
function clientNameProblem(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'CONFLICT') return error.message;
  if (error.code === 'VALIDATION_FAILED') return `Enter a name between 1 and ${MAXIMUM_CLIENT_NAME_LENGTH} characters.`;
  return null;
}

function AddClientForm({ stationId }: { stationId: string }) {
  const [name, setName] = useState('');
  const createClient = useCreateClient(stationId);
  const showToast = useToast();
  const problem = clientNameProblem(createClient.error);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    createClient.mutate(
      { name: trimmedName },
      {
        onSuccess: () => {
          setName('');
          showToast(`${trimmedName} added`);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-4 md:flex-row md:items-end">
      <div className="flex-1">
        <TextField
          label="Add a client"
          hint="The business you upload ads for, like “Brand A”."
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAXIMUM_CLIENT_NAME_LENGTH}
          counter={`${[...name].length} / ${MAXIMUM_CLIENT_NAME_LENGTH}`}
          error={problem}
          autoComplete="off"
        />
      </div>
      <Button type="submit" isBusy={createClient.isPending} busyLabel="Adding…" disabled={!name.trim()}>
        Add client
      </Button>
      {createClient.isError && !problem ? <ErrorNotice error={createClient.error} /> : null}
    </form>
  );
}

export function ClientsPage() {
  const station = useRequiredCurrentStation();
  const clients = useClients(station.id);
  const canAddClients = canChangeStationContent(station);

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
              </div>
              {clientItem.adCount > 0 ? (
                <Link
                  to={`/stations/${station.id}/ads?client=${clientItem.id}`}
                  className="flex min-h-11 items-center rounded-md px-3 text-label text-accent hover:bg-accent-soft"
                  aria-label={`See ${clientItem.name}'s ads`}
                >
                  See ads
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
