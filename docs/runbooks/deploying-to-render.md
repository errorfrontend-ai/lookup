# Deploying the Look Up showcase to Render

The showcase runs the whole system on Render (Frankfurt), so stations, partners and listeners can try it at one
address. The goal and choices are the user's, 15 October 2026: Render; real email; text messages sent by email until
an SMS provider is chosen (ADR-004).

## What gets made, and what it costs

| Render service | What it is | Plan | About |
|---|---|---|---|
| `lookup-api` | The API, which also serves the station portal | Starter | US$7 a month |
| `lookup-fingerprint-worker` | Prepares uploaded ads and recognises listeners' clips | Starter (Standard, 2 GB, if it runs out of memory) | US$7 (or 25) |
| `lookup-database` | PostgreSQL 16 | Basic 256 MB | about US$6 |
| `lookup-key-value` | The job queue (Valkey), kept on disk | Starter | US$10 |

About **US$30 a month**. Audio files, logos and licence documents are kept in **Cloudflare R2** (free up to 10 GB).
Everything is described in `render.yaml` at the top of the repository; Render reads it when the Blueprint is made.

The portal and the API share one address, `https://lookup-api.onrender.com` (Render adds a few letters if the name
is taken). The portal is at that address; the API at `/api/v1`; the listener app talks to `/api/v1`.

## Before you start: four accounts

1. **Render**: your existing account (Tonse-hub's) is fine; the showcase is a separate Blueprint.
2. **Cloudflare** (free): for R2 (storage) and Turnstile (the "Verify you are human" box on sign-up). R2 asks for a
   payment card even for its free allowance.
3. **An email service** (free), for example **Brevo**: 300 emails a day free. You verify one sender address (the
   "from" address listeners and stations see) and create an SMTP key.
4. **GitHub**: the code must be pushed (Render builds from `main` of errorfrontend-ai/lookup).

## Step by step

### 1. Cloudflare R2 (storage)

1. In Cloudflare: **R2 Object Storage** → enable it → note your **Account ID** (on the R2 overview page).
2. Create three buckets (location: **Automatic**, or Western Europe): `lookup-ad-uploads`, `lookup-licence-documents`,
   `lookup-station-logos`.
3. On each bucket: **Settings → CORS policy → Edit**, and paste (with your portal address):
   - `lookup-ad-uploads`:
     ```json
     [{ "AllowedOrigins": ["https://lookup-api.onrender.com"], "AllowedMethods": ["PUT", "GET"],
        "AllowedHeaders": ["Content-Type", "Range"], "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
        "MaxAgeSeconds": 3600 }]
     ```
   - `lookup-licence-documents`:
     ```json
     [{ "AllowedOrigins": ["https://lookup-api.onrender.com"], "AllowedMethods": ["PUT"],
        "AllowedHeaders": ["Content-Type"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
     ```
   - `lookup-station-logos`:
     ```json
     [{ "AllowedOrigins": ["https://lookup-api.onrender.com"], "AllowedMethods": ["PUT", "GET"],
        "AllowedHeaders": ["Content-Type"], "ExposeHeaders": ["ETag", "Content-Length"], "MaxAgeSeconds": 3600 }]
     ```
4. **R2 → Manage API tokens → Create API token**: permission **Object Read & Write**, applied to those three buckets
   only. Note the **Access Key ID** and **Secret Access Key** (shown once).
   The S3 address is `https://<Account ID>.r2.cloudflarestorage.com`.

### 2. Cloudflare Turnstile (the human check)

1. **Turnstile → Add widget**: name "Look Up", hostname `lookup-api.onrender.com`, mode **Managed**.
2. Note the **Site key** and the **Secret key**.

### 3. Email (Brevo, for example)

1. **Senders**: add and verify the address mail should come from (a Gmail address works for a showcase, but mail from
   your own domain lands in inboxes more reliably).
2. **SMTP & API → SMTP**: create an SMTP key. The server is `smtp-relay.brevo.com`, port `587`.
3. The address Look Up needs is `smtp://<login>:<SMTP key>@smtp-relay.brevo.com:587`. The login is an email address:
   write its `@` as `%40` (for example `smtp://you%40example.com:xsmtpsib-…@smtp-relay.brevo.com:587`).

### 4. The app's own secrets

On your computer, in the repository: `npm run deploy:new-secrets`. It prints four lines (`AUTHENTICATION_SECRET=…`
and three more), made on your computer and shown once. Keep the terminal open for step 6, then clear it.

### 5. Push the code

`git push origin main`.

### 6. Make the Blueprint on Render

1. Render → **New → Blueprint** → connect `errorfrontend-ai/lookup` → branch `main`. Render reads `render.yaml` and
   lists the four services.
2. Fill in what it asks for:

   | Setting | Value |
   |---|---|
   | `AUTHENTICATION_SECRET`, `TWO_FACTOR_ENCRYPTION_SECRET`, `LISTENER_INSTALL_TOKEN_SECRET`, `LISTENER_INSTALL_ID_PEPPER` | the four lines from step 4 |
   | `PORTAL_PUBLIC_ORIGIN` and `ALLOWED_BROWSER_ORIGINS` | `https://lookup-api.onrender.com` |
   | `OBJECT_STORAGE_ENDPOINT` and `OBJECT_STORAGE_PUBLIC_ENDPOINT` | `https://<Account ID>.r2.cloudflarestorage.com` |
   | `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY` | from step 1.4 |
   | `EMAIL_SMTP_URL` | from step 3.3 |
   | `EMAIL_FROM_ADDRESS` | `Look Up <your verified sender>` |
   | `VITE_HUMAN_CHECK_SITE_KEY`, `HUMAN_CHECK_SECRET_KEY` | from step 2.2 |

3. **Apply**. Render makes the database and the job queue, builds both images (10–15 minutes the first time), runs
   the pre-deploy step (it creates the database roles and applies every migration), then starts the API and the
   workers.
4. If Render gave the API a different address (a suffix such as `lookup-api-x1y2`), change `PORTAL_PUBLIC_ORIGIN`,
   `ALLOWED_BROWSER_ORIGINS`, the R2 CORS rules and the Turnstile hostname to it, and redeploy.

### 7. The first super admin

Render → `lookup-api` → **Shell**, then (with your own details):

```sh
SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_FULL_NAME="Your Name" SUPER_ADMIN_PASSWORD='a long passphrase of 15+ characters' sh /app/infra/docker/create-super-admin.sh
```

It prints an authenticator address and a secret once: add it to an authenticator app (Google Authenticator,
Microsoft Authenticator), then clear the shell. Sign in at the portal address; it asks for the app's 6-digit code.

## Checks after the first deploy

1. `https://<address>/api/v1/health` answers `{"status":"ok"}`; `https://<address>/` shows the portal's sign-in.
2. Sign up a station on a phone: the "text message" arrives by email, marked "sent by email for now"; the email link
   arrives; the super admin approves; the approval email arrives.
3. The station uploads an ad: it turns **Ready** within a minute or two (the worker). If it stays "Preparing", read
   the worker's logs; if Render reports it ran out of memory, change its plan to Standard.
4. The listener app (a build pointed at the address) identifies the ad; the Overview's numbers count it.
5. `lookup-key-value` → Info: **Max memory policy** is `noeviction`.

## Notes and known limits of the showcase

- **Database roles.** The pre-deploy step creates `lookup_api`, `lookup_admin_api`, `lookup_fingerprint_worker` and
  the owner `lookup_schema_owner` with Render's database user, which can create roles but is no superuser. This was
  rehearsed on PostgreSQL 16 with such a user (16 October 2026): both the first run and every later one work. If Render
  ever refuses (`permission denied to create role`), the deploy stops before anything starts; ADR-002 names the
  fallback.
- **Encrypted database connections.** Render's private addresses offer no TLS and production refuses an unencrypted
  database connection, so the services use the database's public host (`…frankfurt-postgres.render.com`) with TLS,
  inside the same region. The job queue is reached on Render's private network.
- **Where the API sees clients.** Rate limits count by client address behind one proxy (`TRUSTED_PROXY_COUNT=1`).
  After the first deploy, check in the logs that two phones on different networks are told apart; if not, adjust it.
- **Texts by email.** Until an SMS provider is chosen (ADR-004), each text goes by email to the person it is for.
- **Turning it off.** Suspending the API and the worker in Render stops their charges; the database and the job
  queue are charged while they exist (check Render's current terms before deleting anything with data in it).
