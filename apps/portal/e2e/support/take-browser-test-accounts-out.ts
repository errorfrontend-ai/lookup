import pg from 'pg';
import { cleanUpIsAllowed } from './remove-browser-test-ads';
import { BROWSER_TEST_EMAIL_DOMAIN } from './station-applicant';

/**
 * After the browser tests: what their accounts made must not get in the way of a person's walkthrough.
 *   - The stations they signed up leave the listener app's station list, and one still waiting for review is closed
 *     as rejected, with a note saying why, so the super admin's queue is clear.
 *   - Their invitations to the seeded stations are cancelled, and a test account that joined a seeded station's team
 *     is taken off it, so the seeded Team page is as the seed made it. A test account that follows a seeded station's
 *     client loses that access too, so the seeded Clients page counts nobody (ADR-006).
 *
 * Like the ad clean-up it is deliberately narrow: only a database on this computer, never production, and only
 * accounts with a browser-test address (browser-test-…@example.test, which can never receive mail). Earlier runs'
 * leftovers count too, so a run that stopped half way is tidied by the next one. The development connection is a
 * superuser, which the station status guard lets through for exactly this.
 */
export default async function takeBrowserTestAccountsOut(): Promise<void> {
  const connectionString = process.env.DATABASE_SETUP_URL;
  if (!connectionString || !cleanUpIsAllowed(connectionString, process.env.NODE_ENV)) {
    console.warn('Browser test accounts were left in place: the clean-up only runs against a development database on this computer.');
    return;
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const parameters = [`browser-test-%@${BROWSER_TEST_EMAIL_DOMAIN}`];
    const testAccounts = 'SELECT person.id FROM app.portal_users AS person WHERE person.email LIKE $1';
    const testStations = `SELECT membership.station_id FROM app.station_memberships AS membership WHERE membership.role = 'OWNER' AND membership.portal_user_id IN (${testAccounts})`;
    await client.query('BEGIN');
    const hidden = await client.query(`UPDATE app.stations SET is_listed_in_app = false WHERE is_listed_in_app AND id IN (${testStations})`, parameters);
    const closed = await client.query(
      `UPDATE app.stations SET status = 'REJECTED', review_note = 'Closed after a browser test run.', reviewed_at = now()
        WHERE status = 'PENDING_REVIEW' AND id IN (${testStations})`,
      parameters,
    );
    const cancelled = await client.query(
      `UPDATE app.invitations SET revoked_at = now()
        WHERE invited_email LIKE $1 AND accepted_at IS NULL AND revoked_at IS NULL AND station_id NOT IN (${testStations})`,
      parameters,
    );
    const removed = await client.query(
      `DELETE FROM app.station_memberships WHERE portal_user_id IN (${testAccounts}) AND station_id NOT IN (${testStations})`,
      parameters,
    );
    const unfollowed = await client.query(
      `DELETE FROM app.client_viewers WHERE portal_user_id IN (${testAccounts}) AND station_id NOT IN (${testStations})`,
      parameters,
    );
    await client.query('COMMIT');
    console.log(
      `Browser test accounts: ${hidden.rowCount ?? 0} station(s) taken out of the app's list, ${closed.rowCount ?? 0} closed in the review queue, ` +
        `${cancelled.rowCount ?? 0} invitation(s) cancelled, ${removed.rowCount ?? 0} member(s) taken off the seeded teams and ` +
        `${unfollowed.rowCount ?? 0} client access(es) removed.`,
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
