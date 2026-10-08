# Look Up

Radio listeners tap once to identify the ad they're hearing and get the station's action
buttons (call, WhatsApp, link, map). Stations register, upload ads for their clients, and
schedule when each ad airs.

**Status:** building the thin slice: a station signs in and publishes an ad, the engine
fingerprints it, and the listener app identifies it. Step 1 (foundations), step 2 (the station
portal) and step 3 (the fingerprint workers and `POST /api/v1/recognize`) are built; step 4, the
listener app, is built and tested on the emulator, and its check on a real phone is still to do. What each requirement rests on is in
[docs/requirements-checklist.md](docs/requirements-checklist.md).

| Path | What |
|---|---|
| `apps/api/` | NestJS API: the station portal's routes, listener installs and `POST /recognize`, the job queues, database access with row-level security |
| `apps/portal/` | The station portal (React): sign in, ads, the new-ad wizard, clients, station profile |
| `apps/mobile/` | The listener app (Flutter): tap to identify, then the station's buttons |
| `packages/contracts/` | Shapes shared by the API, the portal, the workers and the app (zod, emitted as JSON Schema) |
| `services/fingerprinter/` | Python fingerprint engine (`lookup_fingerprint`), its queue workers (`workers`) and its benchmark (`bench`) |
| `packages/design-tokens/tokens.json` | Colours (light/dark), type, spacing, radii, breakpoints — one source for the portal and the app |
| `infra/docker-compose.yml` | Local Postgres 16, Valkey 8 and object storage (versitygw), listening on 127.0.0.1 only |
| `spike/` | Phase 0 field guide, benchmark sweeps, and the capture app used to record test clips |
| `docs/conventions.md` | Naming and structure rules for code and the database |
| `docs/security-baseline.md` | Every security control, where it lives, and the test that proves it |
| Wireframes | Clickable canvas: https://claude.ai/artifact/58CSaciWPmduzeYn63TSt8 (private until shared from its Share menu) |

## Run the API tests locally

Needs Node 24 and Docker.

```powershell
docker compose -f infra/docker-compose.yml up -d --wait postgres valkey
copy apps\api\.env.example apps\api\.env    # then replace each CHANGE_ME with a 16+ character password
npm install
npm test                                     # creates the database roles, runs migrations, runs every test
```

`npm run database:create-roles` and `npm run database:migrate` run the same setup steps on their own.

## Run the fingerprint engine and workers' tests

```powershell
cd services/fingerprinter
python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -e ".[postgres,worker,dev]"
.\.venv\Scripts\python.exe -m pytest -q
```

They use the compose Postgres and Valkey (start them first) and read their passwords from
`apps/api/.env`; none is skipped. The API's own tests also start these workers for the end-to-end
recognition tests (`apps/api/test/fingerprint-workers.test.ts`), so the Python environment above is
needed for `npm test` too.

## Run the listener app's tests

Needs Flutter 3.41.9 (as installed; never upgraded for this app). No Docker and no device:

```powershell
cd apps/mobile
flutter analyze
flutter test                                           # unit, widget, journey and structure tests
cd tool; python -m unittest test_fake_listener_api.py test_run_emulator_tests.py
```

On the emulator, against a Python fake API, with Docker **closed** (this PC cannot run both):

```powershell
python tool/run_emulator_tests.py                     # builds release APKs, boots lookup_test, drives the app
```

It refuses to start while Docker or another emulator runs, and writes a run record with a screen dump
and screenshot of any failure. Only release builds are used, because only the release Flutter engines
are on this PC. The app's design and decisions are in
[docs/design/step-4-listener-app.md](docs/design/step-4-listener-app.md).

## Run the whole system

```powershell
docker compose -f infra/docker-compose.yml up -d --wait
npm run database:migrate; npm run database:seed     # the development station and its owner
npm run start:watch -w @lookup/api                  # the API on http://localhost:3100
npm run dev -w @lookup/portal                       # the portal on http://localhost:5180
npm run workers                                     # the ingest and recognize workers
```

Each worker takes two jobs at once, as in production; on a computer short of memory, set
`WORKER_CONCURRENCY=1` first. Stop the workers with Ctrl+C, which also stops their pool processes.

With the workers running, an uploaded ad goes from "Preparing for recognition" to "Ready for
listeners" within seconds, and `POST /api/v1/installs` then `POST /api/v1/recognize` identify a clip
of it. The engine's settings and why they were chosen are in
[docs/adr/ADR-001-fingerprint-engine.md](docs/adr/ADR-001-fingerprint-engine.md); how the pieces fit
is in [docs/design/step-3-engine-hookup.md](docs/design/step-3-engine-hookup.md).
