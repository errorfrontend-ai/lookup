import { MAXIMUM_CLIENT_NAME_LENGTH } from '@lookup/contracts';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ClientAvatar } from '../../components/client-avatar';
import { ErrorNotice } from '../../components/error-notice';
import { SkeletonRows } from '../../components/skeleton';
import { TextField } from '../../components/text-field';
import { useClients, useCreateClient } from '../clients/use-clients';
import { browserMaxLength } from '../../formatting/text-length';

const SHOW_FILTER_FROM_CLIENT_COUNT = 7;

/** Step 1: whose ad is it. Pick one of the station's clients, or add a new one right here. */
export function ClientStep({ stationId, selectedClientId, onSelect }: { stationId: string; selectedClientId: string | null; onSelect: (clientId: string) => void }) {
  const clients = useClients(stationId);
  const createClient = useCreateClient(stationId);
  const [filter, setFilter] = useState('');
  const [newName, setNewName] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const allClients = clients.data ?? [];
  const shownClients = allClients.filter((client) => client.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const duplicateOf = createClient.error instanceof ApiError && createClient.error.code === 'CONFLICT' ? allClients.find((client) => client.name.toLowerCase() === newName.trim().toLowerCase()) : undefined;

  const addClient = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    createClient.mutate(
      { name },
      {
        onSuccess: (created) => {
          setNewName('');
          setIsAdding(false);
          onSelect(created.id);
        },
      },
    );
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-display">Who is this ad for?</h1>
        <p className="text-body text-muted">Choose the client, or add a new one. Each ad belongs to one client.</p>
      </div>

      {clients.isPending ? <SkeletonRows count={3} /> : null}
      {clients.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice error={clients.error} title="We couldn't load your clients" />
          <Button variant="secondary" onClick={() => void clients.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}

      {clients.isSuccess ? (
        <>
          {allClients.length >= SHOW_FILTER_FROM_CLIENT_COUNT ? <TextField label="Find a client" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} autoComplete="off" /> : null}

          {allClients.length > 0 ? (
            <fieldset className="flex flex-col gap-2 border-0 p-0">
              <legend className="sr-only">Client</legend>
              {shownClients.map((client) => (
                <label
                  key={client.id}
                  className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border-2 bg-surface px-4 py-2 ${selectedClientId === client.id ? 'border-accent bg-accent-soft' : 'border-line-soft'}`}
                >
                  <input type="radio" name="client" value={client.id} checked={selectedClientId === client.id} onChange={() => onSelect(client.id)} className="size-5 accent-[var(--color-accent)]" />
                  <ClientAvatar clientId={client.id} name={client.name} />
                  <span className="text-heading">{client.name}</span>
                </label>
              ))}
              {shownClients.length === 0 ? <p className="text-body text-muted">No client matches “{filter}”.</p> : null}
            </fieldset>
          ) : (
            <p className="rounded-lg border border-dashed border-line bg-surface p-4 text-body text-muted">You have no clients yet. Add the first one below.</p>
          )}

          {isAdding || allClients.length === 0 ? (
            <form onSubmit={addClient} noValidate className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-4">
              <TextField
                label="New client's name"
                hint="The business you are making this ad for, like “Brand A”."
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                maxLength={browserMaxLength(MAXIMUM_CLIENT_NAME_LENGTH)}
                counter={`${[...newName].length} / ${MAXIMUM_CLIENT_NAME_LENGTH}`}
                error={createClient.error instanceof ApiError && createClient.error.code === 'CONFLICT' ? createClient.error.message : null}
                autoComplete="off"
              />
              {duplicateOf ? (
                <Button variant="secondary" className="self-start" onClick={() => onSelect(duplicateOf.id)}>
                  Use the existing “{duplicateOf.name}”
                </Button>
              ) : null}
              {createClient.isError && !(createClient.error instanceof ApiError && createClient.error.code === 'CONFLICT') ? <ErrorNotice error={createClient.error} /> : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" isBusy={createClient.isPending} busyLabel="Adding…" disabled={!newName.trim()}>
                  Add client
                </Button>
                {allClients.length > 0 ? (
                  <Button variant="secondary" onClick={() => setIsAdding(false)}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form>
          ) : (
            <Button variant="secondary" className="self-start" onClick={() => setIsAdding(true)}>
              + New client
            </Button>
          )}
        </>
      ) : null}
    </div>
  );
}
