import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { PLACEHOLDER_PASSWORD_HASH } from './support/test-data.js';

/**
 * Phase 5a's database (P5A design §2): the station status trigger, the registration, two-factor, team and overlap
 * functions, called exactly as the API calls them, and the privileges around them. Each function is called as
 * lookup_api (or lookup_admin_api) inside a transaction that sets the station and user context the way
 * StationScopedTransaction does, and commits, so a flow of several steps reads like the API's.
 */
const STATUSES = ['PENDING_VERIFICATION', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED'] as const;
type StationStatus = (typeof STATUSES)[number];
const ADMIN_MOVES = new Set(['PENDING_REVIEW>ACTIVE', 'PENDING_REVIEW>REJECTED', 'ACTIVE>SUSPENDED', 'SUSPENDED>ACTIVE']);
const OWNER_MOVES = new Set(['PENDING_VERIFICATION>PENDING_REVIEW', 'REJECTED>PENDING_REVIEW']);
const DOCUMENT = { objectKey: 'licence-documents/test/document.pdf', fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: 1234 };

describe('registration and admin database (phase 5a)', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  const runTag = randomUUID().slice(0, 8);
  let emailNumber = 0;
  const createdStationIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdAssetIds: string[] = [];

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
  });
  afterEach(async () => {
    const stationIds = createdStationIds.splice(0);
    const userIds = createdUserIds.splice(0);
    await setupClient.query('DELETE FROM app.audit_events WHERE station_id = ANY($1) OR actor_portal_user_id = ANY($2)', [stationIds, userIds]);
    await setupClient.query('DELETE FROM app.station_change_requests WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = ANY($1) OR portal_user_id = ANY($2)', [stationIds, userIds]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [userIds]);
    await setupClient.query('DELETE FROM fingerprints.audio_assets WHERE id = ANY($1)', [createdAssetIds.splice(0)]);
  });
  afterAll(async () => {
    await apiClient.end();
    await setupClient.end();
  });

  const newEmail = (label: string) => `${label}.${runTag}.${(emailNumber += 1)}@example.com`;
  const newTokenHash = () => randomBytes(32);
  const requestId = () => `request-${randomUUID()}`;

  /** Runs work as the given role with the API's context set, and commits. */
  async function asRole<Result>(
    client: pg.Client,
    scope: { stationId?: string; userId?: string; role?: 'lookup_admin_api' | 'lookup_schema_owner' },
    work: (client: pg.Client) => Promise<Result>,
  ): Promise<Result> {
    await client.query('BEGIN');
    try {
      if (scope.role) await client.query(`SET LOCAL ROLE ${scope.role}`);
      await client.query(`SELECT set_config('app.current_station_id', $1, true), set_config('app.current_user_id', $2, true)`, [
        scope.stationId ?? '',
        scope.userId ?? '',
      ]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (problem) {
      await client.query('ROLLBACK');
      throw problem;
    }
  }
  const asApi = <Result>(scope: { stationId?: string; userId?: string }, work: (client: pg.Client) => Promise<Result>) =>
    asRole(apiClient, scope, work);
  const asAdmin = <Result>(userId: string | undefined, work: (client: pg.Client) => Promise<Result>) =>
    asRole(setupClient, { userId, role: 'lookup_admin_api' }, work);

  /** Step 1 as the API calls it: a new applicant, their station and a session. */
  async function registerApplicant(options: { email?: string; phone?: string } = {}) {
    const email = options.email ?? newEmail('applicant');
    const result = await apiClient.query(
      'SELECT * FROM app.register_station_applicant($1, $2, $3, $4, $5, $6)',
      [email, 'Applicant Person', options.phone ?? '+447700900101', PLACEHOLDER_PASSWORD_HASH, newTokenHash(), requestId()],
    );
    const row = result.rows[0] as { new_portal_user_id: string; new_station_id: string; new_portal_session_id: string; new_refresh_token_expires_at: Date };
    createdStationIds.push(row.new_station_id);
    createdUserIds.push(row.new_portal_user_id);
    return { userId: row.new_portal_user_id, stationId: row.new_station_id, sessionId: row.new_portal_session_id, email, row };
  }
  type Applicant = Awaited<ReturnType<typeof registerApplicant>>;
  const scopeOf = (applicant: Applicant) => ({ stationId: applicant.stationId, userId: applicant.userId });

  async function createUser(options: { platformRole?: 'SUPER_ADMIN' | 'SUPPORT'; email?: string } = {}) {
    const userId = randomUUID();
    const email = options.email ?? newEmail('person');
    await setupClient.query(
      `INSERT INTO app.portal_users (id, email, password_hash, full_name, platform_role) VALUES ($1, $2, $3, 'Test Person', $4)`,
      [userId, email, PLACEHOLDER_PASSWORD_HASH, options.platformRole ?? null],
    );
    createdUserIds.push(userId);
    return { userId, email };
  }
  async function createStation(status: StationStatus, name: string | null = `Station ${runTag}`) {
    const stationId = randomUUID();
    await setupClient.query(`INSERT INTO app.stations (id, name, frequency_label, status) VALUES ($1, $2, $3, $4)`, [
      stationId, name, name === null ? null : '98.1 FM', status,
    ]);
    createdStationIds.push(stationId);
    return stationId;
  }
  const addMember = (stationId: string, userId: string, role: 'OWNER' | 'MANAGER' | 'ANALYST') =>
    setupClient.query(`INSERT INTO app.station_memberships (station_id, portal_user_id, role) VALUES ($1, $2, $3)`, [stationId, userId, role]);
  async function station(stationId: string) {
    return (await setupClient.query('SELECT * FROM app.stations WHERE id = $1', [stationId])).rows[0];
  }
  async function auditActions(stationId: string): Promise<string[]> {
    return (await setupClient.query('SELECT action FROM app.audit_events WHERE station_id = $1 ORDER BY id', [stationId])).rows.map((row) => row.action);
  }
  /** An applicant with every part of the application filled in and confirmed, still PENDING_VERIFICATION. */
  async function completeApplicant() {
    const applicant = await registerApplicant();
    await asApi(scopeOf(applicant), async (client) => {
      await client.query('SELECT app.record_station_phone_verified($1, $2, $3)', [applicant.stationId, '+447700900101', requestId()]);
      await client.query('SELECT app.save_station_application_details($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
        applicant.stationId, `Complete FM ${runTag}`, '91.3 FM', 'Lusaka', 'Lusaka', 'Africa/Lusaka', null, null, requestId(),
      ]);
      await client.query('SELECT app.save_station_licence_number($1, $2, $3)', [applicant.stationId, 'IBA-0001', requestId()]);
      await client.query('SELECT * FROM app.attach_station_licence_document($1, $2, $3, $4, $5, $6)', [
        applicant.stationId, DOCUMENT.objectKey, DOCUMENT.fileName, DOCUMENT.contentType, DOCUMENT.byteCount, requestId(),
      ]);
    });
    const tokenHash = newTokenHash();
    await asApi(scopeOf(applicant), (client) => client.query('SELECT * FROM app.issue_email_verification_link($1, $2, $3)', [applicant.stationId, tokenHash, requestId()]));
    await apiClient.query('SELECT app.confirm_email_verification_link($1, $2)', [tokenHash, requestId()]);
    return applicant;
  }
  async function submit(applicant: Applicant) {
    return (await asApi(scopeOf(applicant), (client) => client.query('SELECT * FROM app.submit_station_application($1, $2)', [applicant.stationId, requestId()]))).rows[0] as {
      outcome: string; missing_parts: string[];
    };
  }

  describe('station status changes (P5A-STATION-STATUS-01..03, P5A-D5)', () => {
    /** Tries one move as one role, inside a transaction that is always rolled back. */
    async function tryMove(role: 'lookup_admin_api' | 'lookup_schema_owner' | 'lookup_api', from: StationStatus, to: StationStatus) {
      const stationId = await createStation(from);
      await setupClient.query('BEGIN');
      try {
        if (role === 'lookup_api') {
          await setupClient.query('SET LOCAL ROLE lookup_api');
          await setupClient.query(`SELECT set_config('app.current_station_id', $1, true)`, [stationId]);
        } else {
          await setupClient.query(`SET LOCAL ROLE ${role}`);
        }
        await setupClient.query('UPDATE app.stations SET status = $2 WHERE id = $1', [stationId, to]);
        return 'allowed';
      } catch (problem) {
        return (problem as Error).message;
      } finally {
        await setupClient.query('ROLLBACK');
      }
    }
    const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));

    it.each(pairs)('P5A-STATION-STATUS-01: %s → %s as a super admin is allowed only for the admin moves', async (from, to) => {
      const outcome = await tryMove('lookup_admin_api', from, to);
      if (from === to || ADMIN_MOVES.has(`${from}>${to}`)) expect(outcome).toBe('allowed');
      else expect(outcome).toMatch(/station status cannot change from/);
    });

    it.each(pairs)('P5A-STATION-STATUS-01: %s → %s inside a definer function is allowed only for the applicant\'s submission', async (from, to) => {
      const outcome = await tryMove('lookup_schema_owner', from, to);
      if (from === to || OWNER_MOVES.has(`${from}>${to}`)) expect(outcome).toBe('allowed');
      else expect(outcome).toMatch(/station status cannot change from/);
    });

    it('P5A-STATION-STATUS-02: the API role holds no privilege on the status at all', async () => {
      for (const [from, to] of [['ACTIVE', 'SUSPENDED'], ['SUSPENDED', 'ACTIVE'], ['PENDING_VERIFICATION', 'PENDING_REVIEW'], ['ACTIVE', 'ACTIVE']] as const) {
        expect(await tryMove('lookup_api', from, to)).toMatch(/permission denied/);
      }
    });

    it('a new station starts as PENDING_VERIFICATION for every role but the set-up superuser', async () => {
      await setupClient.query('BEGIN');
      try {
        await setupClient.query('SET LOCAL ROLE lookup_admin_api');
        await expect(setupClient.query(`INSERT INTO app.stations (name, frequency_label, status) VALUES ('Made Active FM', '90.1 FM', 'ACTIVE')`)).rejects.toThrow(
          /a new station starts as PENDING_VERIFICATION/,
        );
      } finally {
        await setupClient.query('ROLLBACK');
      }
    });

    it('P5A-D2: a station may lack a name and frequency only while PENDING_VERIFICATION', async () => {
      const stationId = await createStation('PENDING_VERIFICATION', null);
      await expect(setupClient.query(`UPDATE app.stations SET status = 'PENDING_REVIEW' WHERE id = $1`, [stationId])).rejects.toThrow(
        /stations_details_required_after_verification_check/,
      );
      await expect(createStation('ACTIVE', null)).rejects.toThrow(/stations_details_required_after_verification_check/);
    });
  });

  describe('sign-up step 1 (P5A-SIGNUP-01..07, P5A-D1)', () => {
    it('creates the user, a PENDING_VERIFICATION station with the applicant as its contact, the OWNER membership and a live session', async () => {
      const applicant = await registerApplicant({ phone: '+447700900102' });
      expect(await station(applicant.stationId)).toMatchObject({
        status: 'PENDING_VERIFICATION', name: null, frequency_label: null, contact_name: 'Applicant Person',
        contact_phone_number_e164: '+447700900102', phone_verified_at: null, email_verified_at: null, time_zone: 'Africa/Lusaka',
      });
      const membership = await setupClient.query('SELECT role FROM app.station_memberships WHERE station_id = $1 AND portal_user_id = $2', [applicant.stationId, applicant.userId]);
      expect(membership.rows).toEqual([{ role: 'OWNER' }]);
      const owner = await apiClient.query('SELECT app.find_active_portal_session($1) AS owner', [applicant.sessionId]);
      expect(owner.rows[0].owner).toBe(applicant.userId);
      expect(applicant.row.new_refresh_token_expires_at.getTime()).toBeGreaterThan(Date.now());
      expect(await auditActions(applicant.stationId)).toEqual(['station_application_started']);
    });

    it('P5A-SIGNUP-07: an email that already has an account, in any letter case, is refused by the unique constraint the API maps', async () => {
      const first = await registerApplicant();
      const attempt = registerApplicant({ email: first.email.toUpperCase() });
      await expect(attempt).rejects.toMatchObject({ code: '23505', constraint: 'portal_users_email_unique' });
    });
  });

  describe('callers are checked inside the functions', () => {
    it('another station\'s owner, a manager, or the owner working in another station gets NOT_ALLOWED from every step function', async () => {
      const applicant = await registerApplicant();
      const other = await registerApplicant();
      const manager = await createUser();
      await addMember(applicant.stationId, manager.userId, 'MANAGER');
      const scopes = [
        { stationId: applicant.stationId, userId: other.userId },
        { stationId: applicant.stationId, userId: manager.userId },
        { stationId: other.stationId, userId: applicant.userId },
      ];
      for (const scope of scopes) {
        const outcomes = await asApi(scope, async (client) => [
          (await client.query('SELECT outcome FROM app.change_applicant_contact($1, $2, $3, $4, $5)', [applicant.stationId, 'Intruder', newEmail('intruder'), '+447700900199', requestId()])).rows[0].outcome,
          (await client.query('SELECT app.record_station_phone_verified($1, $2, $3) AS outcome', [applicant.stationId, '+447700900101', requestId()])).rows[0].outcome,
          (await client.query('SELECT outcome FROM app.issue_email_verification_link($1, $2, $3)', [applicant.stationId, newTokenHash(), requestId()])).rows[0].outcome,
          (await client.query('SELECT app.save_station_application_details($1, $2, $3, $4, $5, $6, $7, $8, $9) AS outcome', [applicant.stationId, 'X', '1 FM', 'Lusaka', 'Lusaka', 'Africa/Lusaka', null, null, requestId()])).rows[0].outcome,
          (await client.query('SELECT app.save_station_licence_number($1, $2, $3) AS outcome', [applicant.stationId, 'X', requestId()])).rows[0].outcome,
          (await client.query('SELECT outcome FROM app.attach_station_licence_document($1, $2, $3, $4, $5, $6)', [applicant.stationId, 'k', 'f.pdf', 'application/pdf', 1, requestId()])).rows[0].outcome,
          (await client.query('SELECT outcome FROM app.submit_station_application($1, $2)', [applicant.stationId, requestId()])).rows[0].outcome,
          (await client.query('SELECT outcome FROM app.request_station_detail_change($1, $2, $3, $4, NULL, NULL, NULL, NULL, $5)', [applicant.stationId, 'X', '1 FM', 'L', requestId()])).rows[0].outcome,
          (await client.query('SELECT outcome FROM app.withdraw_station_detail_change($1, $2)', [applicant.stationId, requestId()])).rows[0].outcome,
          (await client.query('SELECT outcome FROM app.create_station_invitation($1, $2, $3, $4, $5)', [applicant.stationId, newEmail('invitee'), 'ANALYST', newTokenHash(), requestId()])).rows[0].outcome,
          (await client.query('SELECT app.revoke_station_invitation($1, $2, $3) AS outcome', [applicant.stationId, randomUUID(), requestId()])).rows[0].outcome,
          (await client.query('SELECT app.remove_station_member($1, $2, $3) AS outcome', [applicant.stationId, applicant.userId, requestId()])).rows[0].outcome,
        ]);
        expect(new Set(outcomes)).toEqual(new Set(['NOT_ALLOWED']));
      }
      expect(await station(applicant.stationId)).toMatchObject({ name: null, contact_name: 'Applicant Person', licence_number: null });
    });
  });

  describe('step 1 changed later (P5A-SIGNUP-SCREENS, gap 3)', () => {
    it('a changed phone clears its confirmation; a changed email clears its confirmation and supersedes the open links', async () => {
      const applicant = await completeApplicant();
      const openLink = newTokenHash();
      await setupClient.query('UPDATE app.stations SET email_verified_at = NULL WHERE id = $1', [applicant.stationId]);
      await asApi(scopeOf(applicant), (client) => client.query('SELECT * FROM app.issue_email_verification_link($1, $2, $3)', [applicant.stationId, openLink, requestId()]));
      await setupClient.query('UPDATE app.stations SET email_verified_at = now() WHERE id = $1', [applicant.stationId]);

      const sameDetails = await asApi(scopeOf(applicant), (client) =>
        client.query('SELECT * FROM app.change_applicant_contact($1, $2, $3, $4, $5)', [applicant.stationId, 'Applicant Renamed', applicant.email, '+447700900101', requestId()]));
      expect(sameDetails.rows[0]).toEqual({ outcome: 'CHANGED', is_phone_number_changed: false, is_email_changed: false });
      expect(await station(applicant.stationId)).toMatchObject({ contact_name: 'Applicant Renamed', phone_verified_at: expect.any(Date), email_verified_at: expect.any(Date) });

      const newAddress = newEmail('moved');
      const changed = await asApi(scopeOf(applicant), (client) =>
        client.query('SELECT * FROM app.change_applicant_contact($1, $2, $3, $4, $5)', [applicant.stationId, 'Applicant Renamed', newAddress, '+447700900103', requestId()]));
      expect(changed.rows[0]).toEqual({ outcome: 'CHANGED', is_phone_number_changed: true, is_email_changed: true });
      expect(await station(applicant.stationId)).toMatchObject({ contact_phone_number_e164: '+447700900103', phone_verified_at: null, email_verified_at: null });
      const user = await setupClient.query('SELECT email::text AS email, phone_number_e164 FROM app.portal_users WHERE id = $1', [applicant.userId]);
      expect(user.rows[0]).toEqual({ email: newAddress, phone_number_e164: '+447700900103' });
      expect((await apiClient.query('SELECT app.confirm_email_verification_link($1, $2) AS outcome', [openLink, requestId()])).rows[0].outcome).toBe('SUPERSEDED');
    });

    it('an email taken by another account is refused by the unique constraint; an approved station cannot change its contact here', async () => {
      const applicant = await registerApplicant();
      const other = await createUser();
      await expect(asApi(scopeOf(applicant), (client) =>
        client.query('SELECT * FROM app.change_applicant_contact($1, $2, $3, $4, $5)', [applicant.stationId, 'A', other.email, '+447700900101', requestId()]))).rejects.toMatchObject({ code: '23505' });
      const approved = await completeApplicant();
      expect((await submit(approved)).outcome).toBe('SUBMITTED');
      await asAdmin(undefined, (client) => client.query(`UPDATE app.stations SET status = 'ACTIVE' WHERE id = $1`, [approved.stationId]));
      const refused = await asApi(scopeOf(approved), (client) =>
        client.query('SELECT outcome FROM app.change_applicant_contact($1, $2, $3, $4, $5)', [approved.stationId, 'A', newEmail('late'), '+447700900101', requestId()]));
      expect(refused.rows[0].outcome).toBe('NOT_EDITABLE');
    });
  });

  describe('verification (P5A-VERIFICATION-01..06, P5A-D3)', () => {
    it('the phone counts as confirmed only if it is still the number the code was sent to', async () => {
      const applicant = await registerApplicant({ phone: '+447700900104' });
      const verify = (phone: string) => asApi(scopeOf(applicant), (client) => client.query('SELECT app.record_station_phone_verified($1, $2, $3) AS outcome', [applicant.stationId, phone, requestId()]));
      expect((await verify('+447700900105')).rows[0].outcome).toBe('PHONE_NUMBER_CHANGED');
      expect((await station(applicant.stationId)).phone_verified_at).toBeNull();
      expect((await verify('+447700900104')).rows[0].outcome).toBe('VERIFIED');
      expect((await station(applicant.stationId)).phone_verified_at).toBeInstanceOf(Date);
      expect(await auditActions(applicant.stationId)).toEqual(['station_application_started', 'station_phone_verified']);
    });

    it('an email link goes to the account\'s address for 24 hours, works once, from any device, and a newer link supersedes it', async () => {
      const applicant = await registerApplicant();
      const issue = async () => {
        const tokenHash = newTokenHash();
        const result = await asApi(scopeOf(applicant), (client) => client.query('SELECT * FROM app.issue_email_verification_link($1, $2, $3)', [applicant.stationId, tokenHash, requestId()]));
        return { tokenHash, row: result.rows[0] as { outcome: string; recipient_email: string; link_expires_at: Date } };
      };
      const confirm = async (tokenHash: Buffer) => (await apiClient.query('SELECT app.confirm_email_verification_link($1, $2) AS outcome', [tokenHash, requestId()])).rows[0].outcome;

      const first = await issue();
      expect(first.row).toMatchObject({ outcome: 'ISSUED', recipient_email: applicant.email });
      const hoursLeft = (first.row.link_expires_at.getTime() - Date.now()) / 3_600_000;
      expect(hoursLeft).toBeGreaterThan(23.9);
      expect(hoursLeft).toBeLessThanOrEqual(24);
      const second = await issue();
      expect(await confirm(first.tokenHash)).toBe('SUPERSEDED');
      expect(await confirm(newTokenHash())).toBe('NOT_FOUND');
      await setupClient.query(`UPDATE app.email_verification_links SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [second.tokenHash]);
      expect(await confirm(second.tokenHash)).toBe('EXPIRED');

      const third = await issue();
      await setupClient.query('UPDATE app.portal_users SET email = $2 WHERE id = $1', [applicant.userId, newEmail('elsewhere')]);
      expect(await confirm(third.tokenHash)).toBe('EMAIL_CHANGED');
      await setupClient.query('UPDATE app.portal_users SET email = $2 WHERE id = $1', [applicant.userId, applicant.email]);
      expect(await confirm(third.tokenHash)).toBe('CONFIRMED');
      expect(await confirm(third.tokenHash)).toBe('ALREADY_CONFIRMED');
      expect((await station(applicant.stationId)).email_verified_at).toBeInstanceOf(Date);
      expect((await issue()).row.outcome).toBe('ALREADY_CONFIRMED');
      expect(await auditActions(applicant.stationId)).toEqual([
        'station_application_started', 'email_verification_link_sent', 'email_verification_link_sent', 'email_verification_link_sent', 'station_email_verified',
      ]);
    });
  });

  describe('station details and licence (P5A-STATION-DETAILS, P5A-LICENCE)', () => {
    it('saves the details with a province of the ten and a time zone the database knows, and records which fields changed, not their values', async () => {
      const applicant = await registerApplicant();
      const save = (province: string, timeZone: string) => asApi(scopeOf(applicant), (client) =>
        client.query('SELECT app.save_station_application_details($1, $2, $3, $4, $5, $6, $7, $8, $9) AS outcome', [
          applicant.stationId, 'Sunrise FM', '98.1 FM', province, 'Ndola', timeZone, 'Covers the Copperbelt', 'https://stream.example.com/live', requestId(),
        ]));
      expect((await save('Atlantis', 'Africa/Lusaka')).rows[0].outcome).toBe('PROVINCE_NOT_VALID');
      expect((await save('Copperbelt', 'Mars/Olympus_Mons')).rows[0].outcome).toBe('TIME_ZONE_NOT_VALID');
      expect((await save('Copperbelt', 'Africa/Harare')).rows[0].outcome).toBe('SAVED');
      expect(await station(applicant.stationId)).toMatchObject({
        name: 'Sunrise FM', frequency_label: '98.1 FM', province: 'Copperbelt', city: 'Ndola', time_zone: 'Africa/Harare',
        coverage_note: 'Covers the Copperbelt', stream_address: 'https://stream.example.com/live', status: 'PENDING_VERIFICATION',
      });
      const audit = await setupClient.query(`SELECT changes FROM app.audit_events WHERE station_id = $1 AND action = 'station_application_details_saved'`, [applicant.stationId]);
      expect(audit.rows[0].changes).toEqual({ changed_fields: ['name', 'frequency_label', 'province', 'city', 'time_zone', 'coverage_note', 'stream_address'] });
      expect(JSON.stringify(audit.rows)).not.toMatch(/Sunrise|Ndola|stream\.example/);
    });

    it('P5A-STATION-DETAILS-09: the stream address must be https, by the table\'s own check', async () => {
      const applicant = await registerApplicant();
      await expect(asApi(scopeOf(applicant), (client) =>
        client.query('SELECT app.save_station_application_details($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
          applicant.stationId, 'Sunrise FM', '98.1 FM', 'Lusaka', 'Lusaka', 'Africa/Lusaka', null, 'http://stream.example.com/live', requestId(),
        ]))).rejects.toThrow(/stations_stream_address_check/);
    });

    it('a new licence document replaces the old one and hands back its key, so the API can delete the stored file', async () => {
      const applicant = await registerApplicant();
      const attach = (objectKey: string) => asApi(scopeOf(applicant), (client) =>
        client.query('SELECT * FROM app.attach_station_licence_document($1, $2, $3, $4, $5, $6)', [applicant.stationId, objectKey, 'licence.jpg', 'image/jpeg', 2048, requestId()]));
      expect((await attach('licence-documents/first')).rows[0]).toEqual({ outcome: 'ATTACHED', replaced_object_key: null });
      expect((await attach('licence-documents/second')).rows[0]).toEqual({ outcome: 'ATTACHED', replaced_object_key: 'licence-documents/first' });
      expect(await station(applicant.stationId)).toMatchObject({
        licence_document_object_key: 'licence-documents/second', licence_document_content_type: 'image/jpeg', licence_document_byte_count: 2048,
        licence_document_uploaded_at: expect.any(Date),
      });
      await expect(asApi(scopeOf(applicant), (client) =>
        client.query('SELECT * FROM app.attach_station_licence_document($1, $2, $3, $4, $5, $6)', [applicant.stationId, 'k', 'licence.png', 'image/png', 10, requestId()]))).rejects.toThrow(
        /stations_licence_document_content_type_check/,
      );
      await expect(asApi(scopeOf(applicant), (client) =>
        client.query('SELECT * FROM app.attach_station_licence_document($1, $2, $3, $4, $5, $6)', [applicant.stationId, 'k', 'licence.pdf', 'application/pdf', 5_242_881, requestId()]))).rejects.toThrow(
        /stations_licence_document_byte_count_check/,
      );
    });
  });

  describe('submission and review (P5A-ADMIN-QUEUE, journey D)', () => {
    it('an incomplete application names every missing part and stays where it is', async () => {
      const applicant = await registerApplicant();
      expect(await submit(applicant)).toEqual({
        outcome: 'INCOMPLETE',
        missing_parts: ['station_details_missing', 'licence_number_missing', 'licence_document_missing', 'phone_not_verified', 'email_not_verified'],
      });
      expect((await station(applicant.stationId)).status).toBe('PENDING_VERIFICATION');
    });

    it('a complete application goes for review once; a rejection can be fixed and submitted again', async () => {
      const applicant = await completeApplicant();
      expect(await submit(applicant)).toEqual({ outcome: 'SUBMITTED', missing_parts: [] });
      const submitted = await station(applicant.stationId);
      expect(submitted).toMatchObject({ status: 'PENDING_REVIEW', licence_confirmed_at: expect.any(Date), application_submitted_at: expect.any(Date) });
      expect((await submit(applicant)).outcome).toBe('ALREADY_SUBMITTED');

      const admin = await createUser({ platformRole: 'SUPER_ADMIN' });
      await asAdmin(admin.userId, (client) => client.query(
        `UPDATE app.stations SET status = 'REJECTED', review_note = 'The licence document cannot be read.', reviewed_at = now(), reviewed_by_portal_user_id = $2 WHERE id = $1`,
        [applicant.stationId, admin.userId],
      ));
      const fixed = await asApi(scopeOf(applicant), (client) => client.query('SELECT app.save_station_licence_number($1, $2, $3) AS outcome', [applicant.stationId, 'IBA-0002', requestId()]));
      expect(fixed.rows[0].outcome).toBe('SAVED');
      expect(await submit(applicant)).toEqual({ outcome: 'SUBMITTED', missing_parts: [] });
      expect((await station(applicant.stationId)).status).toBe('PENDING_REVIEW');
      const submissions = await setupClient.query(`SELECT changes FROM app.audit_events WHERE station_id = $1 AND action = 'station_application_submitted' ORDER BY id`, [applicant.stationId]);
      expect(submissions.rows.map((row) => row.changes)).toEqual([{ is_resubmission: false }, { is_resubmission: true }]);

      await asAdmin(admin.userId, (client) => client.query(`UPDATE app.stations SET status = 'ACTIVE' WHERE id = $1`, [applicant.stationId]));
      expect((await submit(applicant)).outcome).toBe('NOT_EDITABLE');
      const details = await asApi(scopeOf(applicant), (client) => client.query('SELECT app.save_station_application_details($1, $2, $3, $4, $5, $6, $7, $8, $9) AS outcome', [
        applicant.stationId, 'Renamed FM', '91.3 FM', 'Lusaka', 'Lusaka', 'Africa/Lusaka', null, null, requestId(),
      ]));
      expect(details.rows[0].outcome).toBe('NOT_EDITABLE');
    });
  });

  describe('changes to an approved station (O2, P5A-D4)', () => {
    async function approvedStation() {
      const applicant = await completeApplicant();
      await submit(applicant);
      await asAdmin(undefined, (client) => client.query(`UPDATE app.stations SET status = 'ACTIVE' WHERE id = $1`, [applicant.stationId]));
      return applicant;
    }
    const requestChange = (applicant: Applicant, name: string, documentKey: string | null = null) => asApi(scopeOf(applicant), (client) =>
      client.query('SELECT * FROM app.request_station_detail_change($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
        applicant.stationId, name, '91.3 FM', 'IBA-0001', documentKey, documentKey && 'new.pdf', documentKey && 'application/pdf', documentKey && 4096, requestId(),
      ]));

    it('a station still applying cannot open one; an approved one opens one at a time, only when something differs, and stays ACTIVE as approved', async () => {
      const applying = await registerApplicant();
      expect((await requestChange(applying, 'Early FM')).rows[0].outcome).toBe('NOT_EDITABLE');

      const applicant = await approvedStation();
      expect((await requestChange(applicant, `Complete FM ${runTag}`)).rows[0].outcome).toBe('NOTHING_CHANGED');
      const opened = await requestChange(applicant, 'Renamed FM', 'licence-documents/change');
      expect(opened.rows[0]).toEqual({ outcome: 'REQUESTED', change_request_id: expect.any(String) });
      expect((await requestChange(applicant, 'Another Name FM')).rows[0].outcome).toBe('ALREADY_OPEN');
      expect(await station(applicant.stationId)).toMatchObject({ status: 'ACTIVE', name: `Complete FM ${runTag}` });
      const audit = await setupClient.query(`SELECT changes FROM app.audit_events WHERE station_id = $1 AND action = 'station_detail_change_requested'`, [applicant.stationId]);
      expect(audit.rows[0].changes).toEqual({ changed_fields: ['name', 'licence_document'] });

      const withdrawn = await asApi(scopeOf(applicant), (client) => client.query('SELECT * FROM app.withdraw_station_detail_change($1, $2)', [applicant.stationId, requestId()]));
      expect(withdrawn.rows[0]).toEqual({ outcome: 'WITHDRAWN', withdrawn_document_object_key: 'licence-documents/change' });
      const again = await asApi(scopeOf(applicant), (client) => client.query('SELECT * FROM app.withdraw_station_detail_change($1, $2)', [applicant.stationId, requestId()]));
      expect(again.rows[0].outcome).toBe('NONE_OPEN');
    });

    it('two requests at once still leave one open, by the partial unique index', async () => {
      const applicant = await approvedStation();
      await expect(setupClient.query(
        `INSERT INTO app.station_change_requests (station_id, name, frequency_label, licence_number) VALUES ($1, 'A', '1 FM', 'L'), ($1, 'B', '2 FM', 'L')`,
        [applicant.stationId],
      )).rejects.toThrow(/station_change_requests_one_open_unique_index/);
    });

    it('a super admin decides once; a decided request never changes again', async () => {
      const applicant = await approvedStation();
      const requestIdOfChange = (await requestChange(applicant, 'Renamed FM')).rows[0].change_request_id as string;
      const admin = await createUser({ platformRole: 'SUPER_ADMIN' });
      await asAdmin(admin.userId, (client) => client.query(
        `UPDATE app.station_change_requests SET decision = 'APPROVED', decided_at = now(), decided_by_portal_user_id = $2 WHERE id = $1`,
        [requestIdOfChange, admin.userId],
      ));
      await expect(asAdmin(admin.userId, (client) => client.query(
        `UPDATE app.station_change_requests SET decision = 'REJECTED', decision_note = 'Changed my mind' WHERE id = $1`, [requestIdOfChange],
      ))).rejects.toThrow(/a decided change request cannot change/);
      await expect(asAdmin(admin.userId, (client) => client.query(`UPDATE app.station_change_requests SET name = 'Sneaky FM' WHERE id = $1`, [requestIdOfChange]))).rejects.toThrow(
        /permission denied/,
      );
    });

    it('the station reads its own requests without the document key; another station reads none', async () => {
      const applicant = await approvedStation();
      await requestChange(applicant, 'Renamed FM', 'licence-documents/change');
      const own = await asApi(scopeOf(applicant), (client) => client.query('SELECT name, licence_document_file_name FROM app.station_change_requests'));
      expect(own.rows).toEqual([{ name: 'Renamed FM', licence_document_file_name: 'new.pdf' }]);
      await expect(asApi(scopeOf(applicant), (client) => client.query('SELECT licence_document_object_key FROM app.station_change_requests'))).rejects.toThrow(/permission denied/);
      const other = await registerApplicant();
      const theirs = await asApi(scopeOf(other), (client) => client.query('SELECT id FROM app.station_change_requests WHERE station_id = $1', [applicant.stationId]));
      expect(theirs.rows).toEqual([]);
      await expect(asApi(scopeOf(applicant), (client) =>
        client.query(`INSERT INTO app.station_change_requests (station_id, name, frequency_label, licence_number) VALUES ($1, 'A', '1 FM', 'L')`, [applicant.stationId]))).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe('the super admin\'s second factor (P5A-ADMIN-ACCESS-01..10, §5.4)', () => {
    const ciphertext = randomBytes(48);
    async function signedInSession(userId: string) {
      const result = await setupClient.query(
        `INSERT INTO app.portal_sessions (portal_user_id, expires_at) VALUES ($1, now() + interval '1 day') RETURNING id`, [userId],
      );
      return result.rows[0].id as string;
    }
    const attempt = async (sessionId: string, step: number | null) =>
      (await apiClient.query('SELECT app.record_two_factor_attempt($1, $2, $3) AS outcome', [sessionId, step, requestId()])).rows[0].outcome;

    it('only an enrolled super admin\'s live session reads its secret; each time step is accepted once, then the session has passed', async () => {
      const admin = await createUser({ platformRole: 'SUPER_ADMIN' });
      await setupClient.query('UPDATE app.portal_users SET two_factor_secret_ciphertext = $2, two_factor_enrolled_at = now() WHERE id = $1', [admin.userId, ciphertext]);
      const sessionId = await signedInSession(admin.userId);
      const secret = await apiClient.query('SELECT * FROM app.find_two_factor_secret($1)', [sessionId]);
      expect(secret.rows).toEqual([{ portal_user_id: admin.userId, two_factor_secret_ciphertext: ciphertext, two_factor_last_used_time_step: null }]);

      const describe = async () => (await apiClient.query('SELECT * FROM app.describe_active_portal_session($1)', [sessionId])).rows;
      expect(await describe()).toEqual([{ portal_user_id: admin.userId, platform_role: 'SUPER_ADMIN', two_factor_verified_at: null }]);
      expect(await attempt(sessionId, null)).toBe('FAILED');
      expect(await attempt(sessionId, 59_000_000)).toBe('ACCEPTED');
      expect(await attempt(sessionId, 59_000_000)).toBe('CODE_ALREADY_USED');
      expect(await attempt(sessionId, 58_999_999)).toBe('CODE_ALREADY_USED');
      expect(await attempt(sessionId, 59_000_001)).toBe('ACCEPTED');
      expect((await describe())[0].two_factor_verified_at).toBeInstanceOf(Date);
      const audit = await setupClient.query(`SELECT action FROM app.audit_events WHERE actor_portal_user_id = $1 ORDER BY id`, [admin.userId]);
      expect(audit.rows.map((row) => row.action)).toEqual(['two_factor_failed', 'two_factor_succeeded', 'two_factor_failed', 'two_factor_failed', 'two_factor_succeeded']);

      await setupClient.query(`UPDATE app.portal_sessions SET revoked_at = now(), revocation_reason = 'SIGNED_OUT' WHERE id = $1`, [sessionId]);
      expect((await apiClient.query('SELECT * FROM app.find_two_factor_secret($1)', [sessionId])).rows).toEqual([]);
      expect(await describe()).toEqual([]);
      expect(await attempt(sessionId, 59_000_010)).toBe('NOT_ALLOWED');
    });

    it('P5A-D12: a station user, a SUPPORT user and a super admin not yet enrolled have no secret and cannot pass', async () => {
      for (const user of [await createUser(), await createUser({ platformRole: 'SUPPORT' }), await createUser({ platformRole: 'SUPER_ADMIN' })]) {
        const sessionId = await signedInSession(user.userId);
        expect((await apiClient.query('SELECT * FROM app.find_two_factor_secret($1)', [sessionId])).rows).toEqual([]);
        expect(await attempt(sessionId, 59_000_000)).toBe('NOT_ALLOWED');
      }
    });

    it('P5A-DATABASE-06: neither API role can read or write the second-factor columns directly', async () => {
      for (const role of ['lookup_api', 'lookup_admin_api']) {
        for (const column of ['two_factor_secret_ciphertext', 'two_factor_enrolled_at', 'two_factor_last_used_time_step']) {
          for (const privilege of ['SELECT', 'UPDATE', 'INSERT']) {
            const result = await setupClient.query(`SELECT has_column_privilege($1, 'app.portal_users', $2, $3) AS is_granted`, [role, column, privilege]);
            expect(result.rows[0].is_granted, `${role} ${privilege} ${column}`).toBe(false);
          }
        }
        const session = await setupClient.query(`SELECT has_table_privilege($1, 'app.portal_sessions', 'SELECT') AS is_granted`, [role]);
        expect(session.rows[0].is_granted).toBe(false);
      }
    });
  });

  describe('team invitations (P5A-TEAM, P5A-D16)', () => {
    async function activeOwner() {
      const owner = await createUser();
      const stationId = await createStation('ACTIVE', `Team FM ${runTag}`);
      await addMember(stationId, owner.userId, 'OWNER');
      return { ...owner, stationId, scope: { stationId, userId: owner.userId } };
    }
    const invite = (scope: { stationId: string; userId: string }, email: string, role = 'MANAGER', tokenHash = newTokenHash()) =>
      asApi(scope, async (client) => ({
        tokenHash,
        row: (await client.query('SELECT * FROM app.create_station_invitation($1, $2, $3, $4, $5)', [scope.stationId, email, role, tokenHash, requestId()])).rows[0] as {
          outcome: string; invitation_id: string; invitation_expires_at: Date;
        },
      }));
    const describeInvitation = async (tokenHash: Buffer) => (await apiClient.query('SELECT * FROM app.describe_invitation($1)', [tokenHash])).rows;

    it('an owner of an active station invites for 7 days; the newest invitation to an email replaces the open one; members cannot be invited again', async () => {
      const owner = await activeOwner();
      const invitedEmail = newEmail('invitee');
      const first = await invite(owner.scope, invitedEmail);
      expect(first.row.outcome).toBe('CREATED');
      const daysLeft = (first.row.invitation_expires_at.getTime() - Date.now()) / 86_400_000;
      expect(daysLeft).toBeGreaterThan(6.99);
      expect(daysLeft).toBeLessThanOrEqual(7);
      expect(await describeInvitation(first.tokenHash)).toEqual([{
        invitation_state: 'OPEN', station_name: `Team FM ${runTag}`, station_frequency_label: '98.1 FM', invited_role: 'MANAGER',
        invited_email: invitedEmail, has_account: false, invitation_expires_at: first.row.invitation_expires_at,
      }]);
      const second = await invite(owner.scope, invitedEmail.toUpperCase(), 'ANALYST');
      expect(second.row.outcome).toBe('CREATED');
      expect((await describeInvitation(first.tokenHash))[0].invitation_state).toBe('REVOKED');
      expect((await invite(owner.scope, owner.email.toUpperCase())).row.outcome).toBe('ALREADY_A_MEMBER');

      const applying = await registerApplicant();
      expect((await invite(scopeOf(applying), newEmail('early'))).row.outcome).toBe('STATION_NOT_ACTIVE');
      expect(await describeInvitation(newTokenHash())).toEqual([]);
    });

    it('accepting with a new account makes the member and a session once; an email with an account must sign in instead', async () => {
      const owner = await activeOwner();
      const invitedEmail = newEmail('newcomer');
      const sent = await invite(owner.scope, invitedEmail, 'ANALYST');
      const accept = async (tokenHash: Buffer) => (await apiClient.query('SELECT * FROM app.accept_invitation_with_new_account($1, $2, $3, $4, $5, $6)', [
        tokenHash, 'New Member', '+447700900106', PLACEHOLDER_PASSWORD_HASH, newTokenHash(), requestId(),
      ])).rows[0];
      const accepted = await accept(sent.tokenHash);
      expect(accepted).toMatchObject({ outcome: 'ACCEPTED', joined_station_id: owner.stationId, new_portal_user_id: expect.any(String), new_portal_session_id: expect.any(String) });
      createdUserIds.push(accepted.new_portal_user_id);
      const membership = await setupClient.query('SELECT role FROM app.station_memberships WHERE station_id = $1 AND portal_user_id = $2', [owner.stationId, accepted.new_portal_user_id]);
      expect(membership.rows).toEqual([{ role: 'ANALYST' }]);
      expect((await accept(sent.tokenHash)).outcome).toBe('ALREADY_ACCEPTED');
      expect((await describeInvitation(sent.tokenHash))[0]).toMatchObject({ invitation_state: 'ACCEPTED', has_account: true });

      const existing = await createUser();
      const toExisting = await invite(owner.scope, existing.email);
      expect((await accept(toExisting.tokenHash)).outcome).toBe('ACCOUNT_EXISTS');
      const expired = await invite(owner.scope, newEmail('late'));
      await setupClient.query(`UPDATE app.invitations SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [expired.tokenHash]);
      expect((await accept(expired.tokenHash)).outcome).toBe('EXPIRED');
      expect((await describeInvitation(expired.tokenHash))[0].invitation_state).toBe('EXPIRED');
      expect((await accept(newTokenHash())).outcome).toBe('NOT_FOUND');
    });

    it('accepting while signed in works only with the invited email, once; a revoked invitation no longer works', async () => {
      const owner = await activeOwner();
      const invitee = await createUser();
      const stranger = await createUser();
      const sent = await invite(owner.scope, invitee.email);
      const acceptAs = async (userId: string, tokenHash: Buffer) =>
        (await asApi({ userId }, (client) => client.query('SELECT * FROM app.accept_invitation_for_signed_in_user($1, $2)', [tokenHash, requestId()]))).rows[0];
      expect((await acceptAs(stranger.userId, sent.tokenHash)).outcome).toBe('FOR_ANOTHER_EMAIL');
      expect(await acceptAs(invitee.userId, sent.tokenHash)).toEqual({ outcome: 'ACCEPTED', joined_station_id: owner.stationId });
      expect((await acceptAs(invitee.userId, sent.tokenHash)).outcome).toBe('ALREADY_ACCEPTED');
      expect((await asApi({}, (client) => client.query('SELECT * FROM app.accept_invitation_for_signed_in_user($1, $2)', [sent.tokenHash, requestId()]))).rows[0].outcome).toBe('NOT_SIGNED_IN');

      const revoked = await invite(owner.scope, stranger.email);
      const revoke = await asApi(owner.scope, (client) => client.query('SELECT app.revoke_station_invitation($1, $2, $3) AS outcome', [owner.stationId, revoked.row.invitation_id, requestId()]));
      expect(revoke.rows[0].outcome).toBe('REVOKED');
      expect((await acceptAs(stranger.userId, revoked.tokenHash)).outcome).toBe('REVOKED');
      const twice = await asApi(owner.scope, (client) => client.query('SELECT app.revoke_station_invitation($1, $2, $3) AS outcome', [owner.stationId, revoked.row.invitation_id, requestId()]));
      expect(twice.rows[0].outcome).toBe('NOT_FOUND');
      expect(await auditActions(owner.stationId)).toEqual(['invitation_created', 'invitation_accepted', 'invitation_created', 'invitation_revoked']);
    });

    it('the station reads its invitations without the token hash; another station reads none; nobody writes them directly', async () => {
      const owner = await activeOwner();
      await invite(owner.scope, newEmail('reader'));
      const own = await asApi(owner.scope, (client) => client.query('SELECT station_role, kind FROM app.invitations'));
      expect(own.rows).toEqual([{ station_role: 'MANAGER', kind: 'STATION_MEMBER' }]);
      for (const statement of ['SELECT token_hash FROM app.invitations', `UPDATE app.invitations SET revoked_at = now()`, 'DELETE FROM app.invitations']) {
        await expect(asApi(owner.scope, (client) => client.query(statement))).rejects.toThrow(/permission denied/);
      }
      await expect(asAdmin(undefined, (client) => client.query('SELECT token_hash FROM app.invitations'))).rejects.toThrow(/permission denied/);
      const other = await activeOwner();
      expect((await asApi(other.scope, (client) => client.query('SELECT id FROM app.invitations WHERE station_id = $1', [owner.stationId]))).rows).toEqual([]);
    });

    it('an owner removes members but never the last owner, even when two owners remove each other at once', async () => {
      const owner = await activeOwner();
      const manager = await createUser();
      await addMember(owner.stationId, manager.userId, 'MANAGER');
      const remove = (scope: { stationId: string; userId: string }, userId: string) =>
        asApi(scope, (client) => client.query('SELECT app.remove_station_member($1, $2, $3) AS outcome', [scope.stationId, userId, requestId()]));
      expect((await remove(owner.scope, owner.userId)).rows[0].outcome).toBe('LAST_OWNER');
      expect((await remove(owner.scope, manager.userId)).rows[0].outcome).toBe('REMOVED');
      expect((await remove(owner.scope, manager.userId)).rows[0].outcome).toBe('NOT_FOUND');
      await expect(asApi(owner.scope, (client) => client.query('DELETE FROM app.station_memberships WHERE portal_user_id = $1', [owner.userId]))).rejects.toThrow(/permission denied/);

      // Two owners remove each other at once: the first holds the owner rows' locks until it commits, the second is
      // seen waiting on them (both passed the owner check), and once the first commits it finds one owner left.
      const secondOwner = await createUser();
      await addMember(owner.stationId, secondOwner.userId, 'OWNER');
      const applicationName = `lookup-tests-registration-${runTag}`;
      const otherConnection = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: applicationName });
      await otherConnection.connect();
      const setContext = (client: pg.Client, userId: string) =>
        client.query(`SELECT set_config('app.current_station_id', $1, true), set_config('app.current_user_id', $2, true)`, [owner.stationId, userId]);
      try {
        await apiClient.query('BEGIN');
        await setContext(apiClient, owner.userId);
        await otherConnection.query('BEGIN');
        await setContext(otherConnection, secondOwner.userId);
        const first = await apiClient.query('SELECT app.remove_station_member($1, $2, $3) AS outcome', [owner.stationId, secondOwner.userId, requestId()]);
        const second = otherConnection.query('SELECT app.remove_station_member($1, $2, $3) AS outcome', [owner.stationId, owner.userId, requestId()]);
        let waitEvent: string | null = null;
        for (let attempt = 0; attempt < 100 && waitEvent !== 'Lock'; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const activity = await setupClient.query(`SELECT wait_event_type FROM pg_stat_activity WHERE application_name = $1 AND state = 'active'`, [applicationName]);
          waitEvent = activity.rows[0]?.wait_event_type ?? null;
        }
        expect(waitEvent, 'the second removal waits on the first one\'s locks').toBe('Lock');
        await apiClient.query('COMMIT');
        const secondOutcome = (await second).rows[0].outcome;
        await otherConnection.query('COMMIT');
        expect([first.rows[0].outcome, secondOutcome]).toEqual(['REMOVED', 'LAST_OWNER']);
      } finally {
        await apiClient.query('ROLLBACK').catch(() => undefined);
        await otherConnection.end();
      }
      const owners = await setupClient.query(`SELECT count(*)::int AS owner_count FROM app.station_memberships WHERE station_id = $1 AND role = 'OWNER'`, [owner.stationId]);
      expect(owners.rows[0].owner_count).toBe(1);
    });
  });

  describe('audio to check (P5A-OVERLAP-REVIEW-04, P5A-D11)', () => {
    async function finding() {
      const assetIds = [randomUUID(), randomUUID()];
      for (const assetId of assetIds) {
        await setupClient.query(
          `INSERT INTO fingerprints.audio_assets (id, content_sha256, duration_milliseconds, fingerprint_version, hash_count) VALUES ($1, $2, 30000, 2, 100)`,
          [assetId, randomBytes(32)],
        );
        createdAssetIds.push(assetId);
      }
      const result = await setupClient.query(
        `INSERT INTO fingerprints.asset_overlaps (audio_asset_id, overlapping_audio_asset_id, overlap_milliseconds) VALUES ($1, $2, 6000) RETURNING id`, assetIds,
      );
      return { findingId: result.rows[0].id as string, assetIds };
    }

    it('a super admin lists the findings and marks one checked once; anyone else is refused', async () => {
      const { findingId, assetIds } = await finding();
      const admin = await createUser({ platformRole: 'SUPER_ADMIN' });
      const listed = await asAdmin(admin.userId, (client) => client.query('SELECT * FROM app.list_asset_overlaps_for_review() WHERE finding_id = $1', [findingId]));
      expect(listed.rows).toEqual([expect.objectContaining({
        audio_asset_id: assetIds[0], overlapping_audio_asset_id: assetIds[1], audio_asset_number: expect.any(Number),
        overlapping_audio_asset_number: expect.any(Number), overlap_milliseconds: 6000, reviewed_at: null,
        audio_asset_ads: [], overlapping_audio_asset_ads: [],
      })]);
      const review = (userId: string, target = findingId) =>
        asAdmin(userId, (client) => client.query('SELECT app.record_asset_overlap_review($1, $2, $3) AS outcome', [target, 'Two cuts of one jingle.', requestId()]));
      const support = await createUser({ platformRole: 'SUPPORT' });
      expect((await review(support.userId)).rows[0].outcome).toBe('NOT_ALLOWED');
      expect((await asAdmin(support.userId, (client) => client.query('SELECT * FROM app.list_asset_overlaps_for_review()'))).rows).toEqual([]);
      expect((await review(admin.userId, randomUUID())).rows[0].outcome).toBe('NOT_FOUND');
      expect((await review(admin.userId)).rows[0].outcome).toBe('REVIEWED');
      expect((await review(admin.userId)).rows[0].outcome).toBe('ALREADY_REVIEWED');
      const stored = await setupClient.query('SELECT reviewed_by_portal_user_id, review_note FROM fingerprints.asset_overlaps WHERE id = $1', [findingId]);
      expect(stored.rows[0]).toEqual({ reviewed_by_portal_user_id: admin.userId, review_note: 'Two cuts of one jingle.' });
    });

    it('a finding pairs two different recordings, once', async () => {
      const { assetIds } = await finding();
      await expect(setupClient.query(`INSERT INTO fingerprints.asset_overlaps (audio_asset_id, overlapping_audio_asset_id, overlap_milliseconds) VALUES ($1, $1, 10)`, [assetIds[0]])).rejects.toThrow(
        /asset_overlaps_distinct_assets_check/,
      );
      await expect(setupClient.query(`INSERT INTO fingerprints.asset_overlaps (audio_asset_id, overlapping_audio_asset_id, overlap_milliseconds) VALUES ($1, $2, 10)`, assetIds)).rejects.toThrow(
        /asset_overlaps_pair_unique/,
      );
    });
  });

  describe('privileges (P5A-DATABASE-09)', () => {
    it('P5A-LICENCE-05: the API role reads every station column but the licence document\'s storage key; super admins read it', async () => {
      const readable = await setupClient.query(
        `SELECT attname AS column_name FROM pg_attribute WHERE attrelid = 'app.stations'::regclass AND attnum > 0 AND NOT attisdropped
            AND NOT has_column_privilege('lookup_api', attrelid, attname, 'SELECT')`,
      );
      expect(readable.rows).toEqual([{ column_name: 'licence_document_object_key' }]);
      const admin = await setupClient.query(`SELECT has_column_privilege('lookup_admin_api', 'app.stations', 'licence_document_object_key', 'SELECT') AS is_granted`);
      expect(admin.rows[0].is_granted).toBe(true);
      const updatable = await setupClient.query(
        `SELECT attname AS column_name FROM pg_attribute WHERE attrelid = 'app.stations'::regclass AND attnum > 0 AND NOT attisdropped
            AND has_column_privilege('lookup_api', attrelid, attname, 'UPDATE') ORDER BY attname`,
      );
      expect(updatable.rows.map((row) => row.column_name)).toEqual(['city', 'is_listed_in_app', 'logo_object_key', 'province', 'time_zone']);
    });

    it('neither API role has any privilege on the email links or the audio findings', async () => {
      const grants = await setupClient.query(
        `SELECT role_name || ' ' || privilege || ' ' || target AS grant_description
           FROM unnest(ARRAY['lookup_api', 'lookup_admin_api', 'lookup_fingerprint_worker']) AS role_name,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege,
                unnest(ARRAY['app.email_verification_links', 'fingerprints.asset_overlaps']) AS target
          WHERE has_table_privilege(role_name, target, privilege)`,
      );
      expect(grants.rows).toEqual([]);
    });

    /** Each definer function of the phase, who may run it, and what it returns (ALL-DATABASE-06, -07). */
    const FUNCTIONS: Array<[string, string, string]> = [
      ['app.describe_active_portal_session(uuid)', 'lookup_api', 'TABLE(portal_user_id uuid, platform_role text, two_factor_verified_at timestamp with time zone)'],
      ['app.register_station_applicant(text, text, text, text, bytea, text)', 'lookup_api',
        'TABLE(new_portal_user_id uuid, new_station_id uuid, new_portal_session_id uuid, new_refresh_token_expires_at timestamp with time zone)'],
      ['app.change_applicant_contact(uuid, text, text, text, text)', 'lookup_api', 'TABLE(outcome text, is_phone_number_changed boolean, is_email_changed boolean)'],
      ['app.record_station_phone_verified(uuid, text, text)', 'lookup_api', 'text'],
      ['app.issue_email_verification_link(uuid, bytea, text)', 'lookup_api', 'TABLE(outcome text, recipient_email text, link_expires_at timestamp with time zone)'],
      ['app.confirm_email_verification_link(bytea, text)', 'lookup_api', 'text'],
      ['app.save_station_application_details(uuid, text, text, text, text, text, text, text, text)', 'lookup_api', 'text'],
      ['app.save_station_licence_number(uuid, text, text)', 'lookup_api', 'text'],
      ['app.attach_station_licence_document(uuid, text, text, text, integer, text)', 'lookup_api', 'TABLE(outcome text, replaced_object_key text)'],
      ['app.submit_station_application(uuid, text)', 'lookup_api', 'TABLE(outcome text, missing_parts text[])'],
      ['app.request_station_detail_change(uuid, text, text, text, text, text, text, integer, text)', 'lookup_api', 'TABLE(outcome text, change_request_id uuid)'],
      ['app.withdraw_station_detail_change(uuid, text)', 'lookup_api', 'TABLE(outcome text, withdrawn_document_object_key text)'],
      ['app.find_two_factor_secret(uuid)', 'lookup_api', 'TABLE(portal_user_id uuid, two_factor_secret_ciphertext bytea, two_factor_last_used_time_step bigint)'],
      ['app.record_two_factor_attempt(uuid, bigint, text)', 'lookup_api', 'text'],
      ['app.create_station_invitation(uuid, text, text, bytea, text)', 'lookup_api', 'TABLE(outcome text, invitation_id uuid, invitation_expires_at timestamp with time zone)'],
      ['app.revoke_station_invitation(uuid, uuid, text)', 'lookup_api', 'text'],
      ['app.describe_invitation(bytea)', 'lookup_api',
        'TABLE(invitation_state text, station_name text, station_frequency_label text, invited_role text, invited_email text, has_account boolean, invitation_expires_at timestamp with time zone)'],
      ['app.accept_invitation_with_new_account(bytea, text, text, text, bytea, text)', 'lookup_api',
        'TABLE(outcome text, new_portal_user_id uuid, joined_station_id uuid, new_portal_session_id uuid, new_refresh_token_expires_at timestamp with time zone)'],
      ['app.accept_invitation_for_signed_in_user(bytea, text)', 'lookup_api', 'TABLE(outcome text, joined_station_id uuid)'],
      ['app.remove_station_member(uuid, uuid, text)', 'lookup_api', 'text'],
      ['app.list_asset_overlaps_for_review()', 'lookup_admin_api',
        'TABLE(finding_id uuid, audio_asset_id uuid, audio_asset_number integer, overlapping_audio_asset_id uuid, overlapping_audio_asset_number integer, overlap_milliseconds integer, found_at timestamp with time zone, reviewed_at timestamp with time zone, review_note text, audio_asset_ads jsonb, overlapping_audio_asset_ads jsonb)'],
      ['app.record_asset_overlap_review(uuid, text, text)', 'lookup_admin_api', 'text'],
    ];
    const describeFunction = async (signature: string) =>
      (
        await setupClient.query(
          `SELECT prosecdef AS is_security_definer, proconfig AS settings, pg_get_function_result(oid) AS result,
                  array_remove(ARRAY[CASE WHEN has_function_privilege('lookup_api', oid, 'EXECUTE') THEN 'lookup_api' END,
                                     CASE WHEN has_function_privilege('lookup_admin_api', oid, 'EXECUTE') THEN 'lookup_admin_api' END,
                                     CASE WHEN has_function_privilege('lookup_fingerprint_worker', oid, 'EXECUTE') THEN 'lookup_fingerprint_worker' END], NULL) AS callers
             FROM pg_proc WHERE oid = $1::regprocedure`,
          [signature],
        )
      ).rows[0] as { is_security_definer: boolean; settings: string[]; result: string; callers: string[] };

    it.each(FUNCTIONS)('ALL-DATABASE-06, -07: %s is a definer function with its search path pinned, run only by %s, returning what it documents', async (signature, caller, result) => {
      expect(await describeFunction(signature)).toEqual({
        is_security_definer: true,
        settings: [expect.stringMatching(/^search_path=pg_catalog, .*pg_temp$/)],
        result,
        callers: [caller],
      });
    });

    it.each(['app.is_current_station_owner(uuid)', 'app.guard_station_status_change()', 'app.guard_station_change_request_decision()'])(
      'ALL-DATABASE-08: the helper %s is run by no service role, keeps the rights of whoever calls it, and pins its search path',
      async (signature) => {
        expect(await describeFunction(signature)).toMatchObject({ is_security_definer: false, settings: [expect.stringMatching(/^search_path=pg_catalog, .*pg_temp$/)], callers: [] });
      },
    );
  });

  describe('"Find by reference code" (§4.6, gap 14)', () => {
    it('request ids of recognitions (every month) and audit events have prefix indexes', async () => {
      const indexes = await setupClient.query(
        `SELECT indexrelid::regclass::text AS index_name, pg_get_indexdef(indexrelid) AS definition FROM pg_index
          WHERE indrelid IN ('app.audit_events'::regclass, 'app.recognition_events'::regclass) AND pg_get_indexdef(indexrelid) LIKE '%request_id%'`,
      );
      expect(indexes.rows).toEqual(expect.arrayContaining([
        { index_name: 'app.audit_events_request_id_index', definition: expect.stringContaining('(request_id text_pattern_ops)') },
        { index_name: 'app.recognition_events_request_id_index', definition: expect.stringContaining('(request_id text_pattern_ops)') },
      ]));
      const partitions = await setupClient.query(
        `SELECT partition_table.relname AS partition_name,
                EXISTS (SELECT 1 FROM pg_index JOIN pg_class AS partition_index ON partition_index.oid = pg_index.indexrelid
                         WHERE pg_index.indrelid = partition_table.oid AND partition_index.relname = partition_table.relname || '_request_id_index') AS has_index
           FROM pg_inherits JOIN pg_class AS partition_table ON partition_table.oid = pg_inherits.inhrelid
          WHERE pg_inherits.inhparent = 'app.recognition_events'::regclass`,
      );
      expect(partitions.rows.length).toBeGreaterThan(1);
      expect(partitions.rows.filter((row) => !row.has_index)).toEqual([]);
    });
  });
});
