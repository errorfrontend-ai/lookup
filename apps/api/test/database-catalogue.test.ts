import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseSetupClient } from './support/database-clients.js';

/**
 * Facts about the migrated database read from the system catalogue: names, owners, roles, row-level
 * security, constraints and indexes. Each test names the requirement it proves (docs/requirements-checklist.md).
 */
const OUR_SCHEMAS = ['app', 'fingerprints', 'recognition'];
const LOGIN_ROLES = ['lookup_api', 'lookup_admin_api', 'lookup_fingerprint_worker'];
const SCHEMA_OWNER = 'lookup_schema_owner';
const STATION_OWNED_TABLES = [
  'action_cards', 'ads', 'campaign_time_windows', 'campaigns', 'clients', 'station_memberships',
  'recognition_candidates', 'engagement_events', 'campaign_counters',
];
/** Tables with no row-level security, each for a stated reason. */
const TABLES_WITHOUT_ROW_LEVEL_SECURITY: Record<string, string> = {
  'app.listener_installs': 'global (no station); reached only through SECURITY DEFINER recognition functions',
  'app.migrations': 'TypeORM bookkeeping; no service role has any grant on it',
  'fingerprints.audio_assets': 'global, shared across stations; no grant to either API role',
  'fingerprints.hashes_version_1': 'global, shared across stations; no grant to either API role',
};
/** Tables that name a station but give stations no policy, each for a stated reason. */
const TABLES_WITH_A_STATION_BUT_NO_STATION_POLICY: Record<string, string> = {
  'app.recognition_reports': '"Report this" reports are for super admins only (the 5a console); no station ever reads them (P4-D28)',
};
/** Tables with row-level security and no policy at all: no service role reads or writes them directly. */
const TABLES_WITH_NO_POLICY: Record<string, string> = {
  'app.engagement_deduplication_keys': 'one tap per recognition and action across months; only recognition.record_engagement touches it',
  'app.portal_sessions': 'only the sign-in functions touch it',
  'app.recognition_idempotency_keys': 'only the recognition functions touch it',
  'app.refresh_tokens': 'only the sign-in functions touch it',
};
/** Tables whose ids the API makes (UUID version 7, time-ordered for the busiest tables), or that number their rows. */
const TABLES_WITHOUT_AN_ID_DEFAULT = ['migrations', 'recognition_events', 'audit_events', 'engagement_events'];

describe('database catalogue', () => {
  let client: pg.Client;
  const rows = async <Row>(sql: string, parameters: unknown[] = []) => (await client.query(sql, parameters)).rows as Row[];

  beforeAll(async () => {
    client = databaseSetupClient();
    await client.connect();
  });
  afterAll(async () => client.end());

  describe('names', () => {
    it('S1-NAMING-01, S1-NAMING-02, S1-MIGRATIONS-06: schemas app, fingerprints and recognition exist, owned by the schema owner; fp and recog do not', async () => {
      const schemas = await rows<{ nspname: string; owner: string }>(
        `SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ANY($1)`,
        [[...OUR_SCHEMAS, 'fp', 'recog']],
      );
      expect(schemas.map((schema) => schema.nspname).sort()).toEqual([...OUR_SCHEMAS].sort());
      for (const schema of schemas) expect(schema.owner).toBe(SCHEMA_OWNER);
    });

    it('S1-NAMING-03: exactly the four Look Up roles exist; the earlier names do not', async () => {
      const roles = await rows<{ rolname: string }>(
        `SELECT rolname FROM pg_roles WHERE rolname LIKE 'lookup\\_%' OR rolname IN ('app_api', 'app_admin', 'app_fp', 'lookup_owner') ORDER BY rolname`,
      );
      expect(roles.map((role) => role.rolname)).toEqual(['lookup_admin_api', 'lookup_api', 'lookup_fingerprint_worker', 'lookup_schema_owner']);
    });

    it('S1-NAMING-05, S1-MIGRATIONS-10: the slice tables exist under their domain names; the blueprint names do not', async () => {
      const tables = await rows<{ table_name: string }>(
        `SELECT relnamespace::regnamespace || '.' || relname AS table_name FROM pg_class
          WHERE relnamespace = ANY($1::regnamespace[]) AND relkind IN ('r', 'p') AND NOT relispartition`,
        [OUR_SCHEMAS],
      );
      const tableNames = tables.map((table) => table.table_name);
      for (const expected of [
        'app.stations', 'app.portal_users', 'app.station_memberships', 'app.refresh_tokens', 'app.clients', 'app.action_cards',
        'app.ads', 'app.campaigns', 'app.campaign_time_windows', 'fingerprints.audio_assets', 'fingerprints.hashes_version_1',
        'app.listener_installs', 'app.recognition_events', 'app.audit_events',
        'app.recognition_candidates', 'app.engagement_events', 'app.engagement_deduplication_keys', 'app.campaign_counters', 'app.recognition_reports',
      ]) {
        expect(tableNames).toContain(expected);
      }
      for (const blueprintName of ['tenants', 'media_items', 'actionable_payloads', 'campaign_schedules', 'recognition_logs', 'fingerprints']) {
        expect(tableNames.some((name) => name.endsWith(`.${blueprintName}`))).toBe(false);
      }
    });

    it('S1-NAMING-06: no column is named with a reserved SQL word', async () => {
      const offenders = await rows<{ column_name: string }>(
        `SELECT attrelid::regclass || '.' || attname AS column_name
           FROM pg_attribute JOIN pg_class ON pg_class.oid = attrelid
          WHERE relnamespace = ANY($1::regnamespace[]) AND attnum > 0 AND NOT attisdropped
            AND attname IN (SELECT word FROM pg_get_keywords() WHERE catcode = 'R')`,
        [OUR_SCHEMAS],
      );
      expect(offenders).toEqual([]);
    });

    it('S1-NAMING-07: every constraint has a readable name ending in its kind (no generated _pkey, _fkey or PK_ names)', async () => {
      const offenders = await rows<{ constraint_name: string }>(
        `SELECT conrelid::regclass || ': ' || conname AS constraint_name FROM pg_constraint
          WHERE connamespace = ANY($1::regnamespace[])
            AND conname !~ '_(primary_key|foreign_key|unique|check|exclusion)$'`,
        [OUR_SCHEMAS],
      );
      expect(offenders).toEqual([]);
    });

    it('S3-STRUCTURE-02: every yes-or-no column and function output is named as a question (is_ or has_)', async () => {
      const booleans = await rows<{ name: string }>(
        `SELECT table_schema || '.' || table_name || '.' || column_name AS name FROM information_schema.columns
          WHERE table_schema IN ('app', 'fingerprints', 'recognition') AND data_type = 'boolean'
         UNION ALL
         SELECT specific_schema || '.' || specific_name || '.' || parameter_name FROM information_schema.parameters
          WHERE specific_schema IN ('app', 'fingerprints', 'recognition') AND data_type = 'boolean' AND parameter_mode IN ('OUT', 'INOUT')`,
      );
      expect(booleans.length).toBeGreaterThan(2);
      expect(booleans.filter((boolean) => !/\.(is|has)_[a-z_]+$/.test(boolean.name))).toEqual([]);
    });
  });

  describe('roles', () => {
    it('S1-ROLES-02, S1-ROLES-05, S1-ROLES-06, S1-ROLES-07, S1-ROLES-04: the owner cannot sign in; service roles can, with no superuser, no BYPASSRLS, no role or database creation', async () => {
      const roles = await rows<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
        `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname LIKE 'lookup\\_%'`,
      );
      for (const role of roles) {
        expect(role, role.rolname).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
        expect(role.rolcanlogin, role.rolname).toBe(role.rolname !== SCHEMA_OWNER);
      }
      expect(roles).toHaveLength(4);
    });

    it.each([
      ['S1-ROLES-09, S1-ROLES-10', 'lookup_api', ['search_path=app', 'statement_timeout=5s', 'lock_timeout=3s', 'idle_in_transaction_session_timeout=15s']],
      ['S1-ROLES-09, S1-ROLES-11', 'lookup_admin_api', ['search_path=app', 'statement_timeout=15s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=30s']],
      ['S1-ROLES-09, S1-ROLES-12', 'lookup_fingerprint_worker', ['search_path=fingerprints, app', 'statement_timeout=60s', 'lock_timeout=10s', 'idle_in_transaction_session_timeout=60s']],
    ])('%s: %s has a fixed search path and server-side time limits', async (_requirements, roleName, expectedSettings) => {
      const [role] = await rows<{ rolconfig: string[] }>(`SELECT rolconfig FROM pg_roles WHERE rolname = $1`, [roleName]);
      expect([...(role?.rolconfig ?? [])].sort()).toEqual([...expectedSettings].sort());
    });

    it('S1-ROLES-02, S1-MIGRATIONS-01, S1-MIGRATIONS-03: the schema owner owns every table, index, sequence and function (apart from extension members, which Postgres gives to the installing superuser)', async () => {
      const otherOwners = await rows<{ object_name: string; owner: string }>(
        `SELECT relnamespace::regnamespace || '.' || relname AS object_name, pg_get_userbyid(relowner) AS owner
           FROM pg_class WHERE relnamespace = ANY($1::regnamespace[]) AND relowner <> $2::regrole
         UNION ALL
         SELECT proc.oid::regprocedure::text, pg_get_userbyid(proowner)
           FROM pg_proc AS proc
          WHERE pronamespace = ANY($1::regnamespace[]) AND proowner <> $2::regrole
            AND NOT EXISTS (SELECT 1 FROM pg_depend WHERE objid = proc.oid AND deptype = 'e')`,
        [OUR_SCHEMAS, SCHEMA_OWNER],
      );
      expect(otherOwners).toEqual([]);
    });

    it('S1-ROLES-05: service roles own nothing at all', async () => {
      const owned = await rows<{ object_name: string }>(
        `SELECT relname AS object_name FROM pg_class WHERE relowner = ANY($1::regrole[])
         UNION ALL SELECT proname FROM pg_proc WHERE proowner = ANY($1::regrole[])
         UNION ALL SELECT nspname FROM pg_namespace WHERE nspowner = ANY($1::regrole[])
         UNION ALL SELECT typname FROM pg_type WHERE typowner = ANY($1::regrole[])`,
        [LOGIN_ROLES],
      );
      expect(owned).toEqual([]);
    });

    it('S1-MIGRATIONS-02: no service role can create anything in any schema or in the database', async () => {
      const grants = await rows<{ role_name: string; target: string }>(
        `SELECT role_name, 'schema ' || nspname AS target
           FROM unnest($1::text[]) AS role_name, pg_namespace
          WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' AND has_schema_privilege(role_name, pg_namespace.oid, 'CREATE')
         UNION ALL
         SELECT role_name, 'database' FROM unnest($1::text[]) AS role_name WHERE has_database_privilege(role_name, current_database(), 'CREATE')`,
        [LOGIN_ROLES],
      );
      expect(grants).toEqual([]);
    });

    it('S1-ROLES-05: every station table has an explicit full-access policy for the super-admin role', async () => {
      for (const tableName of [...STATION_OWNED_TABLES, 'stations', 'portal_users', 'audit_events', 'recognition_events', 'recognition_reports']) {
        const policies = await rows<{ polname: string; roles: string[] }>(
          `SELECT polname, ARRAY(SELECT rolname::text FROM pg_roles WHERE oid = ANY(polroles)) AS roles FROM pg_policy WHERE polrelid = $1::regclass`,
          [`app.${tableName}`],
        );
        expect(policies.find((policy) => policy.polname === `${tableName}_admin_full_access`)?.roles, tableName).toEqual(['lookup_admin_api']);
      }
    });
  });

  describe('extensions and ids', () => {
    it('S1-MIGRATIONS-07, S1-MIGRATIONS-08, S1-MIGRATIONS-09: citext and btree_gist are installed, uuid-ossp is not, and ids default to gen_random_uuid()', async () => {
      const extensions = (await rows<{ extname: string }>(`SELECT extname FROM pg_extension`)).map((extension) => extension.extname);
      expect(extensions).toEqual(expect.arrayContaining(['citext', 'btree_gist']));
      expect(extensions).not.toContain('uuid-ossp');
      const idDefaults = await rows<{ table_name: string; column_default: string }>(
        `SELECT table_schema || '.' || table_name AS table_name, column_default FROM information_schema.columns
          WHERE column_name = 'id' AND table_schema = ANY($1) AND table_name <> ALL($2)
            AND table_name NOT LIKE 'recognition\\_events\\_%' AND table_name NOT LIKE 'engagement\\_events\\_%'`,
        [OUR_SCHEMAS, TABLES_WITHOUT_AN_ID_DEFAULT],
      );
      expect(idDefaults.length).toBeGreaterThan(5);
      for (const column of idDefaults) expect(column.column_default, column.table_name).toBe('gen_random_uuid()');
    });
  });

  describe('row-level security', () => {
    it('S1-ISOLATION-04: row-level security is on for every table except the listed global ones, and every table with a station has a station policy', async () => {
      const tables = await rows<{ table_name: string; relrowsecurity: boolean; has_station: boolean; station_policy_count: number }>(
        `SELECT relnamespace::regnamespace || '.' || relname AS table_name, relrowsecurity,
                EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = pg_class.oid AND attname = 'station_id' AND NOT attisdropped) AS has_station,
                (SELECT count(*)::int FROM pg_policy WHERE polrelid = pg_class.oid
                   AND (pg_get_expr(polqual, polrelid) LIKE '%current_station_id()%' OR pg_get_expr(polwithcheck, polrelid) LIKE '%current_station_id()%')) AS station_policy_count
           FROM pg_class WHERE relnamespace = ANY($1::regnamespace[]) AND relkind IN ('r', 'p') AND NOT relispartition`,
        [OUR_SCHEMAS],
      );
      for (const table of tables) {
        expect(table.relrowsecurity, table.table_name).toBe(!(table.table_name in TABLES_WITHOUT_ROW_LEVEL_SECURITY));
        if (table.has_station && !(table.table_name in TABLES_WITH_A_STATION_BUT_NO_STATION_POLICY)) {
          expect(table.station_policy_count, table.table_name).toBeGreaterThan(0);
        }
      }
    });

    it('the tables with row-level security and no policy at all are exactly the ones only database functions touch', async () => {
      const tables = await rows<{ table_name: string }>(
        `SELECT relnamespace::regnamespace || '.' || relname AS table_name FROM pg_class
          WHERE relnamespace = ANY($1::regnamespace[]) AND relkind IN ('r', 'p') AND NOT relispartition AND relrowsecurity
            AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = pg_class.oid)
          ORDER BY 1`,
        [OUR_SCHEMAS],
      );
      expect(tables.map((table) => table.table_name)).toEqual(Object.keys(TABLES_WITH_NO_POLICY).sort());
    });

    it('every time is stored with its time zone (timestamptz), never as a bare timestamp', async () => {
      const bareTimestamps = await rows<{ column_name: string }>(
        `SELECT table_schema || '.' || table_name || '.' || column_name AS column_name FROM information_schema.columns
          WHERE table_schema = ANY($1) AND data_type = 'timestamp without time zone'`,
        [OUR_SCHEMAS],
      );
      expect(bareTimestamps).toEqual([]);
    });

    it('S1-ISOLATION-15: every station-owned table has a mandatory station_id', async () => {
      for (const tableName of STATION_OWNED_TABLES) {
        const [column] = await rows<{ attnotnull: boolean }>(
          `SELECT attnotnull FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'station_id' AND NOT attisdropped`,
          [`app.${tableName}`],
        );
        expect(column?.attnotnull, tableName).toBe(true);
      }
    });

    it('S3-PRIVACY-01: no table can hold a clip: the only binary columns are keyed hashes and checksums', async () => {
      const binaryColumns = await rows<{ name: string }>(
        `SELECT table_schema || '.' || table_name || '.' || column_name AS name FROM information_schema.columns
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND data_type = 'bytea' ORDER BY 1`,
      );
      expect(binaryColumns.map((column) => column.name)).toEqual([
        'app.ads.upload_content_sha256', 'app.listener_installs.install_id_hash', 'app.refresh_tokens.token_hash', 'fingerprints.audio_assets.content_sha256',
      ]);
    });

    it('S3-SHAREDAUDIO-02: a recording names no station: no column of the fingerprints tables refers to a station, client, ad or campaign', async () => {
      const columns = await rows<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'fingerprints' ORDER BY table_name, ordinal_position`,
      );
      expect(columns.map((column) => column.table_name)).toEqual(expect.arrayContaining(['audio_assets', 'hashes_version_1']));
      expect(columns.filter((column) => /station|client|campaign|ad_id|owner/.test(column.column_name))).toEqual([]);
    });

    it('S1-PRIVILEGES-11: the API roles hold no privilege of any kind on the fingerprints schema or its tables', async () => {
      const grants = await rows<{ grant_description: string }>(
        `SELECT role_name || ' ' || privilege || ' on ' || target AS grant_description
           FROM unnest(ARRAY['lookup_api', 'lookup_admin_api']) AS role_name,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege,
                unnest(ARRAY['fingerprints.audio_assets', 'fingerprints.hashes_version_1']) AS target
          WHERE has_table_privilege(role_name, target, privilege)
         UNION ALL
         SELECT role_name || ' USAGE on schema fingerprints' FROM unnest(ARRAY['lookup_api', 'lookup_admin_api']) AS role_name
          WHERE has_schema_privilege(role_name, 'fingerprints', 'USAGE')`,
      );
      expect(grants).toEqual([]);
    });
  });

  describe('indexes and partitions', () => {
    it('every foreign key has an index led by its first column, so changing a referenced row never scans the referencing table', async () => {
      const unindexed = await rows<{ foreign_key: string }>(
        `SELECT conrelid::regclass || ': ' || conname AS foreign_key FROM pg_constraint AS constraint_entry
          WHERE contype = 'f' AND connamespace = ANY($1::regnamespace[])
            AND NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid = constraint_entry.conrelid AND indkey[0] = constraint_entry.conkey[1])`,
        [OUR_SCHEMAS],
      );
      expect(unindexed).toEqual([]);
    });

    it('S1-SCALING-06: recognition idempotency keys live in a small unpartitioned table keyed by install and idempotency key', async () => {
      const [table] = await rows<{ relkind: string; key_columns: string }>(
        `SELECT relkind::text, pg_get_constraintdef(constraint_entry.oid) AS key_columns
           FROM pg_class JOIN pg_constraint AS constraint_entry ON constraint_entry.conrelid = pg_class.oid AND contype = 'p'
          WHERE pg_class.oid = 'app.recognition_idempotency_keys'::regclass`,
      );
      expect(table).toEqual({ relkind: 'r', key_columns: 'PRIMARY KEY (listener_install_id, idempotency_key)' });
    });

    it('S1-SCALING-07: recognition events have a block-range index on arrival time and a station and capture-time index', async () => {
      const indexes = (await rows<{ definition: string }>(
        `SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid = 'app.recognition_events'::regclass`,
      )).map((index) => index.definition);
      expect(indexes).toContainEqual(expect.stringMatching(/USING brin \(received_at\)/));
      expect(indexes).toContainEqual(expect.stringMatching(/USING btree \(station_id, captured_at\)/));
    });

    it('a partition created later gets readable index and constraint names derived from its parent', async () => {
      await client.query('BEGIN');
      try {
        expect((await rows<{ created: number }>('SELECT app.create_listener_traffic_partitions(9) AS created'))[0]?.created).toBeGreaterThan(0);
        const partitionIndexes = await rows<{ index_name: string; partition_name: string }>(
          `SELECT indexrelid::regclass::text AS index_name, indrelid::regclass::text AS partition_name
             FROM pg_index JOIN pg_inherits ON pg_inherits.inhrelid = pg_index.indrelid
            WHERE pg_inherits.inhparent IN ('app.recognition_events'::regclass, 'app.recognition_candidates'::regclass, 'app.engagement_events'::regclass)`,
        );
        expect(new Set(partitionIndexes.map((index) => index.partition_name.replace(/_(\d{4}_\d{2}|default)$/, ''))).size).toBe(3);
        for (const index of partitionIndexes) {
          expect(index.index_name.startsWith(`${index.partition_name}_`), index.index_name).toBe(true);
          expect(index.index_name).toMatch(/_(primary_key|index)$/);
        }
        // Candidates hold a foreign key on each month of recognitions, named after it, never ..._fkey1.
        const unreadable = await rows<{ constraint_name: string }>(
          `SELECT conrelid::regclass || ': ' || conname AS constraint_name FROM pg_constraint
            WHERE connamespace = ANY($1::regnamespace[]) AND conname !~ '_(primary_key|foreign_key|unique|check|exclusion)$'`,
          [OUR_SCHEMAS],
        );
        expect(unreadable).toEqual([]);
        const monthlyKeys = await rows<{ constraint_name: string }>(
          `SELECT conname AS constraint_name FROM pg_constraint
            WHERE conrelid = 'app.recognition_candidates'::regclass AND confrelid <> 'app.recognition_events'::regclass
              AND confrelid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'app.recognition_events'::regclass)`,
        );
        expect(monthlyKeys.length).toBeGreaterThan(9);
        for (const key of monthlyKeys) expect(key.constraint_name).toMatch(/^recognition_candidates_recognition_events_(\d{4}_\d{2}|default)_foreign_key$/);
      } finally {
        await client.query('ROLLBACK');
      }
    });

    it('P4-D34, ALL-DATABASE-NAMING-11: every index that backs no constraint is named <table>_<columns>_index, or <table>_<rule>_unique_index when it is a partial unique index', async () => {
      const indexes = await rows<{ index_name: string; table_name: string; is_unique: boolean; is_partial: boolean }>(
        `SELECT index_class.relname AS index_name, table_class.relname AS table_name, index_entry.indisunique AS is_unique,
                index_entry.indpred IS NOT NULL AS is_partial
           FROM pg_index AS index_entry
           JOIN pg_class AS index_class ON index_class.oid = index_entry.indexrelid
           JOIN pg_class AS table_class ON table_class.oid = index_entry.indrelid
          WHERE table_class.relnamespace = ANY($1::regnamespace[]) AND table_class.relname <> 'migrations'
            AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE pg_constraint.conindid = index_entry.indexrelid AND pg_constraint.conrelid = index_entry.indrelid)`,
        [OUR_SCHEMAS],
      );
      expect(indexes.length).toBeGreaterThan(20);
      const misnamed = indexes.filter(
        (index) =>
          !index.index_name.startsWith(`${index.table_name}_`) ||
          (index.is_unique && !(index.is_partial && index.index_name.endsWith('_unique_index'))) ||
          (!index.is_unique && (!index.index_name.endsWith('_index') || index.index_name.endsWith('_unique_index'))),
      );
      expect(misnamed).toEqual([]);
      expect(indexes.filter((index) => index.index_name.endsWith('_unique_index')).map((index) => index.index_name)).toEqual(
        expect.arrayContaining(['recognition_candidates_one_chosen_unique_index', 'recognition_candidates_display_position_unique_index']),
      );
    });

    it('P4-DATABASE-05: taps and reports hold no foreign key to recognitions, so an old month of recognitions can always be detached', async () => {
      const keys = await rows<{ table_name: string; referenced_table: string }>(
        `SELECT conrelid::regclass::text AS table_name, confrelid::regclass::text AS referenced_table FROM pg_constraint
          WHERE contype = 'f' AND conrelid IN ('app.engagement_events'::regclass, 'app.recognition_reports'::regclass, 'app.engagement_deduplication_keys'::regclass)
          ORDER BY 1, 2`,
      );
      expect(keys.filter((key) => key.referenced_table.startsWith('app.recognition_events'))).toEqual([]);
      expect(keys.map((key) => `${key.table_name} -> ${key.referenced_table}`)).toEqual([
        'app.engagement_events -> app.action_cards',
        'app.engagement_events -> app.campaigns',
        'app.engagement_events -> app.stations',
        'app.recognition_reports -> app.stations',
      ]);
    });

    it('P4-LIMITS-03: tap limits are counted in campaign_counters, one row per campaign, with row-level security on', async () => {
      const [table] = await rows<{ relkind: string; key_columns: string; relrowsecurity: boolean }>(
        `SELECT relkind::text, pg_get_constraintdef(constraint_entry.oid) AS key_columns, relrowsecurity
           FROM pg_class JOIN pg_constraint AS constraint_entry ON constraint_entry.conrelid = pg_class.oid AND contype = 'p'
          WHERE pg_class.oid = 'app.campaign_counters'::regclass`,
      );
      expect(table).toEqual({ relkind: 'r', key_columns: 'PRIMARY KEY (campaign_id)', relrowsecurity: true });
    });
  });
});
