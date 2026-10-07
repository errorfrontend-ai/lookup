import pg from 'pg';
import { BROWSER_TEST_TITLE_PREFIX } from './sign-in';

/**
 * After the browser tests: takes the ads they made off the development station. A published ad cannot
 * be removed through the portal (it must stop airing first, and pausing is not built yet), so this ends
 * their campaigns and archives them directly, with the database setup connection from apps/api/.env.
 * Only ads whose title starts with the browser-test prefix are touched.
 */
export default async function removeBrowserTestAds(): Promise<void> {
  const connectionString = process.env.DATABASE_SETUP_URL;
  if (!connectionString) {
    console.warn('Browser test ads were left in place: DATABASE_SETUP_URL is not set in apps/api/.env.');
    return;
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const pattern = `${BROWSER_TEST_TITLE_PREFIX}%`;
    await client.query('BEGIN');
    await client.query(`UPDATE app.campaigns SET status = 'ENDED' WHERE status <> 'ENDED' AND ad_id IN (SELECT id FROM app.ads WHERE title LIKE $1 AND archived_at IS NULL)`, [pattern]);
    const archived = await client.query(`UPDATE app.ads SET archived_at = now() WHERE title LIKE $1 AND archived_at IS NULL`, [pattern]);
    await client.query('COMMIT');
    console.log(`Removed ${archived.rowCount ?? 0} browser test ad(s) from the development station.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
