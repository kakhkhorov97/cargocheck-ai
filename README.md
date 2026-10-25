# CargoCheck AI

A shipping-document review workspace: Gemini extracts fields from a commercial invoice and packing list, a reviewer confirms each value against the original, explicit rules flag mismatches, and every decision is recorded in an audit history and a PDF report.

**Live:** [Open CargoCheck AI](https://cargocheck-ai-web.vercel.app)

**Status: early public build (v0.1).** Deployed on Vercel and Render with Neon PostgreSQL, Upstash Redis and Gemini extraction in production. It provides review evidence only: no customs certification and no automatic shipment approval. No accuracy, speed or cost benchmark has been published. The UI is English in this release; Korean localisation is pending.

## Live deployment

```text
Browser ──► Vercel (React/Vite build)
              │  /api/* rewrite
              ▼
            Render (NestJS API in Docker, auto-deploys from develop)
              ├─► Neon PostgreSQL   application state (one transaction-locked JSONB row)
              ├─► Upstash Redis     BullMQ extraction jobs, up to 3 attempts
              └─► Gemini API        structured extraction of both documents
```

- **Frontend:** Vercel serves `apps/web/dist` and rewrites `/api/*` to the Render API (`vercel.json`), so the browser talks to a single origin.
- **API:** Docker image on Render with Poppler and English Tesseract installed. Each commit to `develop` builds and goes live automatically.
- **Data:** `DATABASE_URL` points to Neon PostgreSQL and `REDIS_URL` to Upstash Redis. Secrets live only in the Render environment.
- **AI:** `EXTRACTION_PROVIDER=gemini` in production. On 24 Oct 2026 the synthetic sample (SH-001) went through the live stack end to end: Gemini extraction (`gemini-3.5-flash-lite`), field confirmation, validation (100 vs 90 quantity flagged, invoice arithmetic passed) and a recorded reviewer decision.

Known limits of this deployment:

- The free Render instance sleeps when idle, so the first request after a pause can take up to about 50 seconds.
- Uploaded originals are stored under `DATA_DIR=/app/data` inside the container. Render's free plan has no persistent disk, so those files do not survive a redeploy or restart. Private object storage is the next storage milestone.
- The API runs in Render's Oregon region while Neon and Upstash run in AWS Singapore; co-locating them will reduce request latency.

## Start on your Mac

Install Node.js 24 (or a supported Node.js version >=22), then install the local document tools:

```bash
brew install poppler tesseract
```

Extract the source ZIP and open the `cargocheck-ai` folder in Cursor or VS Code. In its terminal:

```bash
npm ci
cp .env.example .env
npm run samples
npm run dev
```

Configure the SMTP settings described below, then open **http://localhost:4173**. Create an account, verify your email, sign in, then click **Try sample shipment**. The sample PDFs pass through the actual extraction pipeline, without an AI key.

The NestJS API listens at http://localhost:3001. Keep the terminal running. Stop with Ctrl+C. Data and private original files persist in `data/`, which is excluded from Git and from the source archive. Do not run more than one API process against the local-file store.

### First walkthrough

1. Create an account with a password of at least 10 characters, verify your email using the inbox link, then sign in.
2. Click **Try sample shipment**. Two fictional PDFs are uploaded to your review.
3. Wait for extraction, then inspect each **Original document** and **Extracted fields** tab.
4. Confirm the values against the originals. Edit any individual field using its checkmark, or deliberately confirm all fields in a document after review.
5. Open the validation report. It should identify 100 invoiced pieces versus 90 packed pieces, while invoice arithmetic (100 × 2.50 = 250.00 USD) passes.
6. Record an unresolved decision and explanation for the quantity discrepancy.
7. Complete the review and export the PDF report. A completed review may contain a documented unresolved issue; it is not shipment approval.
8. Change the packing quantity. The review reopens and the affected check loses its previous decision. Inspect **Review history** for the correction.

You can also create a review and upload your own PDF/JPG/PNG (10 MB per file; local PDF extraction supports up to 20 pages). Original files are never rewritten.

## Implemented

- React/TypeScript interface using the supplied navy/teal design tokens: dashboard, original document previews, field editing, source text, report and correction history.
- NestJS REST API; account registration and login with salted scrypt password hashes; required email ownership verification; hashed opaque session tokens in HTTP-only cookies; logout.
- Account ownership checks on shipment and document access; non-public local files; signature checks for accepted upload formats; rate limiting; same-origin mutation checks; optimistic version checks for stale edits.
- Local PDF text extraction with Poppler; English OCR with Tesseract for images/scanned PDFs; conservative labelled-template parsing. Unknown fields remain null.
- Optional Gemini extraction adapter using structured output, server-side credentials, schema validation, explicit untrusted-document instructions and unconfirmed results.
- Deterministic checks for shipment reference, seller/consignee/address, explicit product-code matches, compatible units, quantities and invoice line arithmetic using decimal.js.
- Duplicate product codes and ambiguous matches go to review; incompatible units are not automatically converted.
- Field confirmation, reviewer corrections, audit events, per-check decisions, provisional results and review completion gates.
- PDF report export, including values, source text references, decision notes and review status.
- Persistent local-file development store; optional PostgreSQL store and BullMQ/Redis job configuration; bounded extraction retries and visible failures.
- Synthetic sample documents, automated checks, CI configuration and Docker Compose setup.

## Frontend deployment checks

Build the frontend from the repository root:

```bash
npm run build -w @cargo/shared
npm run build -w @cargo/web
```

Vercel serves `apps/web/dist`, as configured in `vercel.json`. A local build does not update the live website. Confirm that the production deployment uses the intended Git commit before checking changes in the browser.

If the browser tab has no CargoCheck icon:

1. Open `/favicon.svg` on the deployed website. It should display the teal cargo cube. A 404 means the deployment is missing the icon.
2. View the deployed page source and check for a `rel="icon"` link to `/favicon.svg`. If it is missing, check the deployed commit and build output.
3. After both checks pass, close and reopen the tab in Chrome to retry loading the icon.

The favicon source is `apps/web/public/favicon.svg`; its HTML link is in `apps/web/index.html`.

## Email verification and SMTP setup

Registration creates an unverified account without a session. The account can access shipment reviews only after its owner follows the inbox link, selects **Verify email**, and signs in. Email verification is also checked on the backend for existing sessions.

There is no production bypass. Missing or invalid SMTP configuration returns HTTP 503 with `EMAIL_CONFIGURATION_ERROR`. Registration does not create an account when configuration is missing. If the SMTP provider rejects delivery after account creation, the account remains unverified and registration returns HTTP 503 with `EMAIL_DELIVERY_FAILED`. Wait 60 seconds, then use **Request a verification link** on the sign-in screen instead of registering again.

Choose a transactional SMTP provider and verify a sender address or domain using that provider's instructions. Configure its SPF/DKIM records and any required DMARC policy. Put real credentials only in your local `.env` or the backend service's secret environment settings. `.env.example` contains placeholders.

For the Render backend, set:

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | `https://cargocheck-ai-web.vercel.app`, the trusted frontend origin without a trailing slash |
| `SMTP_HOST` | Your provider's SMTP hostname |
| `SMTP_PORT` | Your provider's SMTP port, usually `587` or `465` |
| `SMTP_SECURE` | `false` for required STARTTLS, or `true` for implicit TLS |
| `SMTP_USER` | Your SMTP username |
| `SMTP_PASSWORD` | Your SMTP password or provider-issued SMTP credential |
| `SMTP_FROM` | A verified sender email address, such as `verify@your-domain.com` |
| `COOKIE_SECURE` | `true` in HTTPS production |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Your existing production PostgreSQL connection string |

Keep these settings on Render, not in frontend `VITE_*` variables. Use an SMTP provider and port that your Render service can reach. [Render free web services block SMTP ports 25, 465, and 587](https://render.com/docs/free), and port 25 is blocked for all services. Confirm an allowed provider-supported submission port or suitable hosting before deployment; no service purchase or hosting change is performed by this task. Nodemailer requires encrypted SMTP and validates TLS certificates. SMTP acceptance confirms handoff to the provider, not inbox placement or later delivery. See the [Nodemailer SMTP documentation](https://nodemailer.com/smtp).

Verification links are built only from `APP_ORIGIN`. Production requires HTTPS; local development permits `http://localhost:4173`. Tokens use 32 cryptographically random bytes, expire after 30 minutes, and are stored only as SHA-256 hashes. The link uses `/?verify-email#token=...` so the token is not sent in access-log URLs or referrer headers. The page clears the fragment and submits the token in a POST body only when the user selects **Verify email**. Do not configure request-body logging for authentication endpoints or SMTP debug logging.

Endpoints:

- `POST /api/auth/register`: accepts `email`, `password`, and optional `name`. Returns `verificationRequired` only after SMTP acceptance; does not sign in.
- `POST /api/auth/verify-email`: accepts `token`. Returns `success`, `expired`, `invalid`, or `already_used`. Successful consumption and user verification are atomic.
- `POST /api/auth/resend-verification`: accepts `email`. Enforces a persisted 60-second per-account cooldown. Issuing a replacement invalidates older unused links, including when replacement delivery fails.
- `POST /api/auth/login`: requires a verified account. Correct credentials for an unverified account return HTTP 403 with `EMAIL_NOT_VERIFIED`.

Verification and resend endpoints share a limit of 15 requests per IP per 15 minutes, in addition to the existing authentication limits. Public resend responses are identical for unknown, verified, cooldown-limited, and delivery-failed accounts. They explicitly do not confirm delivery. Configuration errors are returned equally for every address. A failed SMTP attempt invalidates its token, preserves the cooldown, and leaves the account unverified. Used, expired, and invalidated token hashes are retained for up to a day after expiry, then pruned when issuing links.

### Existing-account migration policy

Before deploying this change, back up the production `cargo_state` record and configure SMTP. This task does not run a production migration or access the production database.

At the next backend startup, the store applies an idempotent migration in a transaction. Accounts without a verification timestamp receive `emailVerifiedAt: null`. Users, password hashes, shipment ownership, and shipment data remain intact. Sessions belonging to unverified accounts are removed. No existing account is silently marked verified. Emails use the existing trim-and-lowercase normalization consistently. If legacy records collide after normalization, migration stops and rolls back rather than deleting or merging users. An administrator must resolve the conflicting records from a backup-aware maintenance process before restarting.

Existing users select **Request a verification link** on the sign-in screen, enter their email, verify the new link, and sign in with their existing password. Verification does not restore old sessions. Records already verified by this implementation keep their verification timestamp on later restarts.

### Verification checks

Automated tests use in-memory mocked email delivery and temporary local storage. They do not email real users or access the production database. Run `npm test`, `npm run typecheck`, and `npm run build`.

After configuring a real SMTP service and deploying separately, verify delivery with an account you control, including inbox/spam placement, the public link origin, successful verification and sign-in, resend replacement, expiry, and the legacy-user flow. These live delivery checks remain required; mocked tests cannot prove provider credentials, DNS configuration, network reachability, or inbox delivery.

## Extraction modes

### Local OCR (default; no AI key)

Local mode performs real OCR/text extraction, then explicit template parsing. **It is not general-purpose AI extraction.** It recognises labelled lines and pipe-separated item rows, like the included PDFs:

```text
Shipment reference: SH-001
Seller: Sample Export Co.
Consignee: Sample Import Co.
Consignee address: 45 Market Street, Sample Town
Currency: USD
Code | Description | Quantity | Unit | Unit price | Line total
BOOK-01 | Children's Book | 100 | pieces | 2.50 | 250.00
```

Unrecognised layouts may produce missing fields or no items. Add a line and enter confirmed values manually, or configure cloud extraction. OCR is English-only in this release; install/configure additional language data before expanding language claims.

### Gemini cloud (optional; needs your own API access)

In `.env`, set:

```dotenv
EXTRACTION_PROVIDER=gemini
GEMINI_API_KEY=your-key-set-locally
GEMINI_MODEL=your-supported-model-name
```

Restart the API. The sidebar shows **Gemini cloud**. Uploaded documents are sent to Google's Gemini API in this mode. The model name is intentionally configurable; choose one enabled for your account and compatible with document input and structured JSON output. Never paste credentials into source files or commit `.env`.

This mode runs in the live deployment and was exercised end to end with the synthetic sample on 24 Oct 2026 (see **Live deployment**). It has not been evaluated on a labelled dataset, so no accuracy figure is claimed. Schema validity does not prove factual correctness, and model-provided source references must be verified by the reviewer.

Provider references:

- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/gemini-api/docs/document-processing

## PostgreSQL, Redis and Docker

```bash
docker compose up --build
```

Open http://localhost:3001 for the built frontend and API. Compose starts PostgreSQL and Redis and mounts private document storage on a named volume. Docker installs Poppler and Tesseract. The fixed database credentials are for local development only; do not expose this configuration as a production deployment.

Alternatively start your own PostgreSQL/Redis services and set `DATABASE_URL`/`REDIS_URL` in `.env` for local development. No database or Redis URL is needed for the default development workflow.

When `NODE_ENV=production`, startup requires a valid `DATABASE_URL` using the `postgres://` or `postgresql://` scheme. The database host must not be localhost, a loopback address, or an unspecified address such as `0.0.0.0`. Use the hostname of your PostgreSQL service. Local-file storage is available only outside production. These startup checks do not verify database connectivity or make the development Compose configuration suitable for production.

**Storage implementation:** the initial PostgreSQL adapter uses one transaction-locked JSONB state row. This makes the vertical slice straightforward, but is not a scalable relational schema. Normalised tables, migrations, indexing and scoped queries are a planned milestone. Original files use private local disk, not S3 yet. The first queue worker runs in the API process; a standalone worker entrypoint is pending.

PostgreSQL and Redis are exercised in production through Neon and Upstash (see **Live deployment**). The automated test suite uses the local-file/in-process path; the Compose file is for local development and has not been separately integration-tested.

## Checks

```bash
npm test
npm run typecheck
npm run build
```

The 11 tests cover:

- Quantity mismatch and exact decimal arithmetic.
- Unit aliases, incompatible units and blocked comparisons.
- Duplicate product identities, missing/invalid values and missing items.
- Address variations requiring human judgement.
- Invalidating a decision when its underlying comparison changes.
- Conservative parsing and instruction-like document text remaining data.
- Actual sample PDF extraction and source page references.
- End-to-end controller/store/job workflow: registration, account isolation, stale versions, real extraction, confirmation gates, decisions, completion, PDF export, correction history, persistence and invalid upload rejection.

Tests invoke the real controller, storage and extraction jobs, but are not a browser suite or an HTTP routing suite. CI (`.github/workflows/ci.yml`) installs Poppler and Tesseract, generates the samples, runs the tests and builds on every push. The live workflow was checked manually in a browser on 24 Oct 2026; there is no automated browser suite yet.

## Source layout

```text
apps/api/src/       NestJS routes, auth, persistence, extraction and jobs
apps/web/src/       React interface and styles
packages/shared/   Typed schemas and deterministic comparison rules
samples/           Synthetic invoice and packing-list PDFs
scripts/           Development runner and sample PDF generator
tests/             Rules and workflow tests
design-reference/  Supplied Claude interface references
```

## Next milestones

1. Add private object storage for uploaded originals (the free Render disk is ephemeral), with authorised access, retention/deletion and page-level quotas.
2. Evaluate Gemini extraction against a labelled synthetic dataset and publish the results.
3. Introduce normalised PostgreSQL tables/migrations and test Redis retry/recovery behavior.
4. Automated browser QA at desktop and mobile widths, and stronger document parser isolation.
5. Map extracted evidence to verified PDF coordinates for highlight overlays. Current links open the original page and/or the extracted text line; these are **not PDF bounding boxes**.
6. Add Korean UI and Korean OCR/document cases, accessibility review, and a separate evaluation dataset.
7. Expand operational controls for the public deployment: account recovery, backups, monitoring, co-located API and data regions, and report font support for Korean text. PDF export currently uses standard Latin fonts.

This tool provides review evidence. It does not certify customs compliance or automatically approve a shipment.
