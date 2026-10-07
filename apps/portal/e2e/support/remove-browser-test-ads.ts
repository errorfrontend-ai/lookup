import pg from 'pg';
import { BROWSER_TEST_TITLE_PREFIX } from './sign-in';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Whether the clean-up may run against this database: only one on this computer, and never in production. */
export function cleanUpIsAllowed(connectionString: string, nodeEnvironment: string | undefined): boolean {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(host) && nodeEnvironment !== 'production';
}

/**
 * After the browser tests: takes the ads they made off the development station. A published ad cannot
 * be removed through the portal (it must stop airing first, and pausing is not built yet), so this ends
 * their campaigns and archives them directly, with the database setup connection from apps/api/.env.
 *
 * It is deliberately narrow, because that connection can change any station: it runs only against a
 * database on this computer and never in production, and it touches only ads that the seeded owner's
 * station made during this run whose titles start with the browser-test prefix.
 */
export default async function removeBrowserTestAds(): Promise<void> {
  const connectionString = process.env.DATABASE_SETUP_URL;
  const seededOwnerEmail = process.env.SEED_OWNER_EMAIL;
  const startedAt = process.env.BROWSER_TESTS_STARTED_AT;
  if (!connectionString || !seededOwnerEmail || !startedAt) {
    console.warn('Browser test ads were left in place: DATABASE_SETUP_URL and SEED_OWNER_EMAIL must be set in apps/api/.env.');
    return;
  }
  if (!cleanUpIsAllowed(connectionString, process.env.NODE_ENV)) {
    console.warn('Browser test ads were left in place: the clean-up only runs against a development database on this computer.');
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const parameters = [`${BROWSER_TEST_TITLE_PREFIX}%`, seededOwnerEmail, startedAt];
    const theseAds = `
      SELECT ad.id FROM app.ads AS ad
       WHERE ad.title LIKE $1 AND ad.archived_at IS NULL AND ad.created_at >= $3::timestamptz
         AND ad.station_id IN (
           SELECT membership.station_id FROM app.station_memberships AS membership
             JOIN app.portal_users AS person ON person.id = membership.portal_user_id
            WHERE person.email = $2)`;
    await client.query('BEGIN');
    await client.query(`UPDATE app.campaigns SET status = 'ENDED' WHERE status <> 'ENDED' AND ad_id IN (${theseAds})`, parameters);
    const archived = await client.query(`UPDATE app.ads SET archived_at = now() WHERE id IN (${theseAds})`, parameters);
    await client.query('COMMIT');
    console.log(`Removed ${archived.rowCount ?? 0} browser test ad(s) from the development station.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
