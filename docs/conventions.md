# Code and database conventions

Every name in this project says what the thing is or does, in full words. A reader should never
have to decode an abbreviation or guess a unit. These rules apply to all production code
(`apps/`, `services/`, `packages/`) and to every migration.

## Names in code

| Rule | Write | Not |
|---|---|---|
| Whole words, no abbreviations | `dataSource`, `request`, `response`, `error`, `configuration` / `config` | `ds`, `req`, `res`, `err`, `cfg` |
| Units in the name | `windowSeconds`, `timeoutMilliseconds`, `duration_milliseconds` | `windowSec`, `timeoutMs`, `dur` |
| Functions are verbs that say what they do | `assignRequestId`, `rejectCrossSiteCookieRequests`, `countRequest` | `requestId`, `originCheck`, `hit` |
| Booleans read as yes/no questions | `isDeferred`, `refuseWhenStoreUnavailable` | `deferred`, `failClosed` |
| Files are named after their one main export | `station-scoped-transaction.ts` exports `StationScopedTransaction` | `tenant-tx.ts` |
| Domain words, used the same everywhere | station, client (a station's advertiser), ad, action card, campaign, time window, listener install, recognition | tenant, customer, spot, payload |

Accepted exceptions — universal conventions every reader knows: `id`, `url`, `http`, `json`,
`sql`, `uuid`, `csv`, `wav`, established acronyms inside a longer name (`FFT`, `SHA-256`, `E.164`,
`CORS`, `AAC`, `APK`), library-mandated names (pino's `err` log field, Express's `next`, Flutter's
`build`/`context`, the record package's `noiseSuppress`/`autoGain`/`bitRate` — also when our own
settings fields mirror them), and import aliases such as `np` for NumPy. Single-letter names only
for trivial loop counters.

The same rules apply to the Phase 0 tools in `spike/`. Data already written to disk keeps its
format: capture-app clip file names (`…_neg_…_8s_…_t1.m4a`), recorded values such as
`mic/ns-off/agc-off`, and old manifest columns, which the importer renames on read.

## Structure (API)

```
apps/api/src/
  main.ts                          process entry: start the server
  process-failures.ts              last-resort JSON logging of start-up failures and unhandled errors
  app.module.ts                    wires infrastructure, then features
  configure-http-application.ts    the HTTP pipeline, in order, shared with the tests
  config/                          validated configuration (fails closed)
  infrastructure/                  things features rely on: database (one data-source definition,
                                   migrations, partitions), key-value store, object storage, logging
  common/                          cross-cutting rules: errors, http guards, rate limiting, validation
  features/<feature>/              one folder per feature: module, controller, service, input schemas
apps/api/scripts/                  setup commands: database roles, migrations, development seed,
                                   object storage bucket
apps/api/test/                     one file per behaviour; shared helpers in test/support/
```

A new feature is a new folder under `features/` with its own module, imported once in
`app.module.ts`. A feature may use another feature's building blocks that are meant for sharing
(the `stations` access guard; the `ads` record and list-query helpers in `ad-records.ts` and `ad-list-query.ts`), never its services or
private files; rules shared by everything go in `common/`.

## Names in the database

| Thing | Pattern | Example |
|---|---|---|
| Schema | what it holds | `app`, `fingerprints`, `recognition` |
| Table | plural noun | `stations`, `campaign_time_windows`, `listener_installs` |
| Column | full words; `_at` for timestamps; unit suffix for amounts; `is_` for booleans | `received_at`, `duration_milliseconds`, `is_listed_in_app` |
| Foreign key column | `<referenced thing>_id` | `portal_user_id`, `action_card_id` |
| Primary key | `<table>_primary_key` | `stations_primary_key` |
| Foreign key | `<table>_<referenced thing>_foreign_key` | `ads_client_foreign_key` |
| Unique | `<table>_<columns>_unique` | `portal_users_email_unique` |
| Check | `<table>_<subject>_check` | `campaigns_status_check` |
| Exclusion | `<table>_<rule>_exclusion` | `campaigns_one_live_campaign_per_ad_exclusion` |
| Index | `<table>_<columns>_index` | `ads_station_updated_at_index` |
| Policy | `<table>_<who sees what>` | `clients_station_isolation`, `ads_admin_full_access` |
| Trigger | `<table>_<what it does>` | `stations_set_updated_at` |
| Function | verb phrase | `app.current_station_id()`, `app.create_recognition_event_partitions()` |
| Role | `lookup_<who logs in>` | `lookup_api`, `lookup_fingerprint_worker` |
| Session setting | `app.<what it holds>` | `app.current_station_id` |

## Scaling rules for the database

- Tables that grow with listener traffic are **partitioned by month** on their arrival time
  (`recognition_events`). Old months are detached or dropped whole; a scheduled call to
  `app.create_recognition_event_partitions()` keeps future months in place.
- Uniqueness that must hold across months lives in a small unpartitioned table
  (`recognition_idempotency_keys`), cleaned up once it can no longer matter.
- Ids of high-volume rows are **UUIDv7**, generated by the API, so new rows land at the end of the
  index. Low-volume tables use `gen_random_uuid()`.
- Very large lookup tables carry a **version in their name** (`hashes_version_1`), so a rebuild
  happens alongside the live table and switches over without downtime.
- Every foreign key column used for lookups or cascades has an index.
- Station context is set per transaction, so the API runs behind a transaction-mode connection
  pooler when one is needed.

## Changing the schema

New migration file per change, never edits to one that has run anywhere shared. Each migration
grants exactly what its new tables need, per role (and per column where a column is sensitive), and
adds the matching tests in `test/database-privileges.test.ts` or a new test file. See
[security-baseline.md](security-baseline.md).
