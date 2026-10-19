import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Listener accounts (ADR-005, docs/design/listener-accounts.md §5): a listener gives an email, a gender and an age to see
 * the result of an ad scan, so stations can see which groups follow an advert.
 *
 *  - app.listener_accounts: the email as a keyed hash (the lookup key, unique) and a sealed copy (AES-256-GCM, the
 *    account's id bound in by the API), the gender, the birth year (worked out from the age typed at sign-up), and the
 *    consent wording that was agreed. Row-level security is on and there is no policy and no grant for any service
 *    role: the API reaches the table only through the functions below, so a leaked API login cannot read an email.
 *  - app.listener_installs.listener_account_id: which account an install belongs to (none until the listener creates
 *    or signs in to one). One install has at most one account; one account may have many installs (a new phone). The
 *    API role may read it but not write it: only the functions link and unlink. Its INSERT privilege on the table
 *    becomes a list of the four columns the registration writes, so a new install cannot be born already linked.
 *  - Functions for the API, each SECURITY DEFINER with its search path pinned and EXECUTE for lookup_api only:
 *    link_listener_install_to_existing_account, create_listener_account_and_link_install,
 *    unlink_listener_install_from_account, delete_listener_account_of_install, describe_listener_account_of_install
 *    and recognition.find_received_at_of_own_recognition (finds a recognition's partition key from its id, for the
 *    reveal route).
 *
 * Scaling: accounts are one row per listener who signs up, nowhere near the volume of recognitions, so the table is
 * not partitioned. The foreign key from installs is indexed (partially, since most installs will have no account for
 * a while) so deleting an account finds its installs without a scan.
 */
export class ListenerAccounts1791900000000 implements MigrationInterface {
  name = 'ListenerAccounts1791900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);

    await run(`
      CREATE TABLE app.listener_accounts (
        id                   uuid NOT NULL DEFAULT gen_random_uuid(),
        email_hash           bytea NOT NULL,
        email_sealed         bytea NOT NULL,
        gender               text NOT NULL,
        birth_year           smallint NOT NULL,
        consent_text_version text NOT NULL,
        consent_given_at     timestamptz NOT NULL DEFAULT now(),
        created_at           timestamptz NOT NULL DEFAULT now(),
        last_signed_in_at    timestamptz,
        CONSTRAINT listener_accounts_primary_key PRIMARY KEY (id),
        CONSTRAINT listener_accounts_email_hash_unique UNIQUE (email_hash),
        CONSTRAINT listener_accounts_email_hash_length_check CHECK (octet_length(email_hash) = 32),
        CONSTRAINT listener_accounts_email_sealed_length_check CHECK (octet_length(email_sealed) BETWEEN 29 AND 400),
        CONSTRAINT listener_accounts_gender_check CHECK (gender IN ('FEMALE', 'MALE', 'ANOTHER', 'PREFER_NOT_TO_SAY')),
        CONSTRAINT listener_accounts_birth_year_check CHECK (birth_year BETWEEN 1900 AND 2100),
        CONSTRAINT listener_accounts_consent_text_version_check CHECK (char_length(consent_text_version) BETWEEN 1 AND 64)
      )`);
    await run(`ALTER TABLE app.listener_accounts ENABLE ROW LEVEL SECURITY`);

    await run(`
      ALTER TABLE app.listener_installs
        ADD COLUMN listener_account_id uuid,
        ADD CONSTRAINT listener_installs_listener_account_foreign_key
          FOREIGN KEY (listener_account_id) REFERENCES app.listener_accounts (id) ON DELETE SET NULL`);
    await run(`
      CREATE INDEX listener_installs_listener_account_id_index ON app.listener_installs (listener_account_id)
        WHERE listener_account_id IS NOT NULL`);

    // The registration writes these four columns and no other; the account link is written only by the functions.
    await run(`REVOKE INSERT ON app.listener_installs FROM lookup_api`);
    await run(`GRANT INSERT (install_id_hash, platform, app_version, last_seen_at) ON app.listener_installs TO lookup_api`);

    await run(LINK_LISTENER_INSTALL_TO_EXISTING_ACCOUNT);
    await run(CREATE_LISTENER_ACCOUNT_AND_LINK_INSTALL);
    await run(UNLINK_LISTENER_INSTALL_FROM_ACCOUNT);
    await run(DELETE_LISTENER_ACCOUNT_OF_INSTALL);
    await run(DESCRIBE_LISTENER_ACCOUNT_OF_INSTALL);
    await run(FIND_RECEIVED_AT_OF_OWN_RECOGNITION);
    for (const signature of API_FUNCTIONS) await run(`GRANT EXECUTE ON FUNCTION ${signature} TO lookup_api`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);
    for (const signature of API_FUNCTIONS) await run(`DROP FUNCTION ${signature}`);
    await run(`REVOKE INSERT (install_id_hash, platform, app_version, last_seen_at) ON app.listener_installs FROM lookup_api`);
    await run(`GRANT INSERT ON app.listener_installs TO lookup_api`);
    await run(`DROP INDEX app.listener_installs_listener_account_id_index`);
    await run(`
      ALTER TABLE app.listener_installs
        DROP CONSTRAINT listener_installs_listener_account_foreign_key,
        DROP COLUMN listener_account_id`);
    await run(`DROP TABLE app.listener_accounts`);
  }
}

const API_FUNCTIONS = [
  'app.link_listener_install_to_existing_account(uuid, bytea)',
  'app.create_listener_account_and_link_install(uuid, uuid, bytea, bytea, text, smallint, text, text)',
  'app.unlink_listener_install_from_account(uuid)',
  'app.delete_listener_account_of_install(uuid, text)',
  'app.describe_listener_account_of_install(uuid)',
  'recognition.find_received_at_of_own_recognition(uuid, uuid)',
];

/**
 * Signing in: the install of a listener who proved an email that already has an account joins that account.
 * NO_ACCOUNT (the email has none), NO_INSTALL (an unknown install, which a valid token should never be),
 * ALREADY_LINKED (this install already belongs to that account, so nothing changes),
 * LINKED_TO_ANOTHER_ACCOUNT (the install belongs to a different account: sign out first) or LINKED.
 * The install row is locked while this decides, so two sign-ins at once cannot link it twice.
 */
const LINK_LISTENER_INSTALL_TO_EXISTING_ACCOUNT = `
      CREATE FUNCTION app.link_listener_install_to_existing_account(linking_listener_install_id uuid, signing_in_email_hash bytea)
        RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        found_account_id   uuid;
        current_account_id uuid;
      BEGIN
        SELECT listener_account.id INTO found_account_id FROM app.listener_accounts AS listener_account
         WHERE listener_account.email_hash = signing_in_email_hash;
        IF NOT FOUND THEN
          RETURN 'NO_ACCOUNT';
        END IF;
        SELECT listener_install.listener_account_id INTO current_account_id FROM app.listener_installs AS listener_install
         WHERE listener_install.id = linking_listener_install_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN 'NO_INSTALL';
        END IF;
        IF current_account_id IS NOT NULL THEN
          RETURN CASE WHEN current_account_id = found_account_id THEN 'ALREADY_LINKED' ELSE 'LINKED_TO_ANOTHER_ACCOUNT' END;
        END IF;
        UPDATE app.listener_installs SET listener_account_id = found_account_id WHERE id = linking_listener_install_id;
        UPDATE app.listener_accounts SET last_signed_in_at = now() WHERE id = found_account_id;
        RETURN 'LINKED';
      END $$`;

/**
 * Creating the account after a right code for a new email, and linking the install to it. CREATED, or
 * LINKED_EXISTING when the email gained an account since the code was checked (the ticket proves the address, so the
 * install joins it and the details given here are not stored), ALREADY_LINKED, LINKED_TO_ANOTHER_ACCOUNT (the install
 * already belongs to a different account: nothing is created) or NO_INSTALL. The account's id comes from the API,
 * which sealed the email with it. The audit row names the account by id only, never anything the listener said.
 */
const CREATE_LISTENER_ACCOUNT_AND_LINK_INSTALL = `
      CREATE FUNCTION app.create_listener_account_and_link_install(new_account_id uuid, linking_listener_install_id uuid, new_email_hash bytea,
                                                                   new_email_sealed bytea, new_gender text, new_birth_year smallint,
                                                                   new_consent_text_version text, request_id text)
        RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        existing_account_id uuid;
        current_account_id  uuid;
        created_account_id  uuid;
      BEGIN
        SELECT listener_install.listener_account_id INTO current_account_id FROM app.listener_installs AS listener_install
         WHERE listener_install.id = linking_listener_install_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN 'NO_INSTALL';
        END IF;
        SELECT listener_account.id INTO existing_account_id FROM app.listener_accounts AS listener_account
         WHERE listener_account.email_hash = new_email_hash;
        IF current_account_id IS NOT NULL THEN
          RETURN CASE WHEN current_account_id = existing_account_id THEN 'ALREADY_LINKED' ELSE 'LINKED_TO_ANOTHER_ACCOUNT' END;
        END IF;
        IF existing_account_id IS NULL THEN
          INSERT INTO app.listener_accounts (id, email_hash, email_sealed, gender, birth_year, consent_text_version, last_signed_in_at)
          VALUES (new_account_id, new_email_hash, new_email_sealed, new_gender, new_birth_year, new_consent_text_version, now())
          ON CONFLICT (email_hash) DO NOTHING
          RETURNING id INTO created_account_id;
          IF created_account_id IS NULL THEN
            SELECT listener_account.id INTO existing_account_id FROM app.listener_accounts AS listener_account
             WHERE listener_account.email_hash = new_email_hash;
          END IF;
        END IF;
        UPDATE app.listener_installs SET listener_account_id = coalesce(created_account_id, existing_account_id)
         WHERE id = linking_listener_install_id;
        IF created_account_id IS NOT NULL THEN
          INSERT INTO app.audit_events (action, entity_type, entity_id, request_id)
          VALUES ('listener_account_created', 'listener_account', created_account_id, request_id);
          RETURN 'CREATED';
        END IF;
        UPDATE app.listener_accounts SET last_signed_in_at = now() WHERE id = existing_account_id;
        RETURN 'LINKED_EXISTING';
      END $$`;

/** Signing out: this install leaves its account; the account and its other installs stay. UNLINKED or NOT_LINKED. */
const UNLINK_LISTENER_INSTALL_FROM_ACCOUNT = `
      CREATE FUNCTION app.unlink_listener_install_from_account(unlinking_listener_install_id uuid) RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      BEGIN
        UPDATE app.listener_installs SET listener_account_id = NULL
         WHERE id = unlinking_listener_install_id AND listener_account_id IS NOT NULL;
        RETURN CASE WHEN FOUND THEN 'UNLINKED' ELSE 'NOT_LINKED' END;
      END $$`;

/**
 * Deleting the account of an install: the email (hash and sealed copy), gender, birth year and consent record are
 * erased, and the foreign key's ON DELETE SET NULL unlinks every install of the account. Recognitions stay: they hold
 * nothing about the person. The audit row keeps the account's id only. DELETED or NO_ACCOUNT.
 */
const DELETE_LISTENER_ACCOUNT_OF_INSTALL = `
      CREATE FUNCTION app.delete_listener_account_of_install(deleting_listener_install_id uuid, request_id text) RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        deleted_account_id uuid;
      BEGIN
        SELECT listener_install.listener_account_id INTO deleted_account_id FROM app.listener_installs AS listener_install
         WHERE listener_install.id = deleting_listener_install_id FOR UPDATE;
        IF deleted_account_id IS NULL THEN
          RETURN 'NO_ACCOUNT';
        END IF;
        DELETE FROM app.listener_accounts WHERE id = deleted_account_id;
        INSERT INTO app.audit_events (action, entity_type, entity_id, request_id)
        VALUES ('listener_account_deleted', 'listener_account', deleted_account_id, request_id);
        RETURN 'DELETED';
      END $$`;

/** The account an install belongs to (none: no rows), with its sealed email so Settings can show it masked. */
const DESCRIBE_LISTENER_ACCOUNT_OF_INSTALL = `
      CREATE FUNCTION app.describe_listener_account_of_install(asking_listener_install_id uuid)
        RETURNS TABLE (listener_account_id uuid, email_sealed bytea)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT listener_account.id, listener_account.email_sealed
          FROM app.listener_installs AS listener_install
          JOIN app.listener_accounts AS listener_account ON listener_account.id = listener_install.listener_account_id
         WHERE listener_install.id = asking_listener_install_id
      $$`;

/**
 * The partition key (received_at) of a finished recognition the install made, found from its id between the two
 * bounds the id gives (P4-D32), so the lookup reads one or two monthly partitions. NULL for an unknown id, another
 * install's recognition or one still being worked on: all look the same. The reveal route then replays it.
 */
const FIND_RECEIVED_AT_OF_OWN_RECOGNITION = `
      CREATE FUNCTION recognition.find_received_at_of_own_recognition(asked_recognition_id uuid, asking_listener_install_id uuid)
        RETURNS timestamptz
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT event.received_at
          FROM app.recognition_events AS event
         WHERE event.id = asked_recognition_id
           AND event.received_at >= recognition.compute_earliest_receipt_time(asked_recognition_id)
           AND event.received_at <= recognition.compute_latest_receipt_time(asked_recognition_id)
           AND event.listener_install_id = asking_listener_install_id
           AND event.outcome <> 'PENDING'
      $$`;
