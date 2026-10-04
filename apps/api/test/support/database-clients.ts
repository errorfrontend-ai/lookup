import pg from 'pg';

/** A connection as the setup user (local superuser): seeds and cleans up test data, bypassing every policy. */
export function databaseSetupClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.DATABASE_SETUP_URL, application_name: 'lookup-tests-setup' });
}

/** A connection as lookup_api, exactly what the running API uses. */
export function lookupApiClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'lookup-tests-api' });
}

/**
 * Run statements as lookup_api inside a transaction that always rolls back, with the station and
 * user context set the same way StationScopedTransaction sets it.
 */
export async function asLookupApi<Result>(
  client: pg.Client,
  scope: { stationId?: string; userId?: string },
  work: (client: pg.Client) => Promise<Result>,
): Promise<Result> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.current_station_id', $1, true), set_config('app.current_user_id', $2, true)`, [
      scope.stationId ?? '',
      scope.userId ?? '',
    ]);
    return await work(client);
  } finally {
    await client.query('ROLLBACK');
  }
}
