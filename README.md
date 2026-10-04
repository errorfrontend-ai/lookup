# Look Up

Radio listeners tap once to identify the ad they're hearing and get the station's action
buttons (call, WhatsApp, link, map). Stations register, upload ads for their clients, and
schedule when each ad airs.

**Status:** building the thin slice: a station signs in and publishes an ad, the engine
fingerprints it, and the listener app identifies it. Step 1 (foundations: database, security,
API skeleton) is done; step 2 (sign-in and the station portal) is next.

| Path | What |
|---|---|
| `apps/api/` | NestJS API: configuration, errors, logging, rate limiting, database access with row-level security |
| `services/fingerprinter/` | Python fingerprint engine (`lookup_fingerprint`) and its benchmark (`bench`) |
| `packages/design-tokens/tokens.json` | Colours (light/dark), type, spacing, radii, breakpoints — one source for the portal and the app |
| `infra/docker-compose.yml` | Local Postgres 16 and Valkey 8 (listening on 127.0.0.1 only) |
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

## Run the fingerprint engine tests

```powershell
cd services/fingerprinter
python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -e ".[postgres,dev]"
.\.venv\Scripts\python.exe -m pytest -q
```

The Postgres tests run when `LOOKUP_FINGERPRINT_TEST_DATABASE_URL` is set, e.g.
`postgresql://lookup:lookup_development_only@127.0.0.1:55432/lookup`.
