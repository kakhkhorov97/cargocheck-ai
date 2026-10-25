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

Open **http://localhost:4173**. Create an account with your email and password, then click **Try sample shipment**. Registration signs you in immediately; email verification is deferred. The sample PDFs pass through the actual extraction pipeline, without an AI key.

The NestJS API listens at http://localhost:3001. Keep the terminal running. Stop with Ctrl+C. Data and private original files persist in `data/`, which is excluded from Git and from the source archive. Do not run more than one API process against the local-file store.

### First walkthrough

1. Create an account with a valid email and a password of at least 10 characters. Registration signs you in immediately. Existing users can sign in with their email and password.
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
- NestJS REST API; account registration and login with salted scrypt password hashes; email verification deferred; hashed opaque session tokens in HTTP-only cookies; logout.
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

## Authentication and deferred email verification

Users can register and sign in with an email and password. Registration signs the user in immediately. Existing unverified accounts can sign in with their current passwords and retain their shipment data. Authentication does not send email or require SMTP or Resend credentials.

Email format validation, trim-and-lowercase email normalization, unique emails, salted scrypt password hashes, hashed session tokens, HTTP-only cookies, session expiry, logout, and per-user shipment isolation remain enforced. Authentication endpoints retain the limit of 30 requests per IP per 15 minutes, alongside the existing general API limit.

Email ownership remains separate from password authentication. New accounts have `emailVerifiedAt: null`. Loading a legacy account without this field adds `null`; existing verification timestamps are preserved. Valid sessions are no longer revoked because an account is unverified. Sessions revoked by a previous release cannot be restored; those users simply sign in again. Users, password hashes, shipment ownership, shipment data, and stored verification records are preserved. Normalization collisions stop storage loading and roll back rather than merging or deleting accounts.

The active endpoints are `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, and `POST /api/auth/logout`. Registration and login return the public user profile and set a session cookie. The verification and resend endpoints are not registered and return 404. The frontend does not route to verification screens or request verification emails, including when opening an old verification URL.

`apps/api/src/email.ts`, `apps/api/src/verification.ts`, and `apps/web/src/verification.tsx` remain isolated for future work. They are not wired into the active authentication flow. There is no runtime environment switch to re-enable them; reinstating verification requires an explicit code change and testing.

### Deployment configuration

No new environment variables are required. Keep `APP_ORIGIN` set to the exact trusted frontend origin, such as `https://cargocheck-ai-web.vercel.app`, because it still controls allowed request origins. Keep `COOKIE_SECURE=true` for HTTPS production and preserve the existing `NODE_ENV`, `DATABASE_URL`, extraction, and queue settings. SMTP and Resend variables can remain unset or be removed from Render; authentication ignores them even if they are configured. No production database maintenance or email service setup is required for this change.

Deploy the frontend and backend together in a separate deployment step so both use the restored password-only flow. This task does not deploy, contact real email recipients, or modify production data. Tests use temporary local storage and mock the dormant SMTP code. When email ownership verification is added later, sender setup, delivery testing, token handling, and an explicit existing-account policy must be revisited.

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
