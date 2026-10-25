# CargoCheck AI

A working first development version of a shipping-document review workspace, based on the supplied CargoCheck case study and five HTML/CSS concepts.

**Status: development vertical slice, not a production release.** No accuracy, speed or cost benchmark has been published. The UI is English in this release; Korean localisation is pending.

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

Open **http://localhost:4173**. Create a local account, then click **Try sample shipment**. The sample PDFs pass through the actual extraction pipeline, without an AI key.

The NestJS API listens at http://localhost:3001. Keep the terminal running. Stop with Ctrl+C. Data and private original files persist in `data/`, which is excluded from Git and from the source archive. Do not run more than one API process against the local-file store.

### First walkthrough

1. Create an account with a password of at least 10 characters.
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
- NestJS REST API; account registration and login with salted scrypt password hashes; hashed opaque session tokens in HTTP-only cookies; logout.
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

The adapter is implemented but has **not been exercised against a live paid provider in this build**, because no API credentials were supplied. Validate it with synthetic documents before relying on it. Schema validity does not prove factual correctness, and model-provided source references must be verified by the reviewer.

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

The Docker/PostgreSQL/Redis configuration has not been integration-tested here because Docker and those services were unavailable. The local-file/in-process path is the tested one.

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

Tests invoke the real controller, storage and extraction jobs, but are not a browser suite or an HTTP routing suite. Frontend type checking and production build passed. The supervised dev server started; the browser automation connection timed out, so visual/browser interaction QA remains unverified.

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

1. Browser QA at desktop and mobile widths, with actual file upload and PDF preview checks.
2. Exercise Gemini extraction using synthetic documents; compare extraction output to labels.
3. Introduce normalised PostgreSQL tables/migrations and test Redis retry/recovery behavior.
4. Add private object storage with authorised access, document retention/deletion, page-level quotas and stronger document parser isolation.
5. Map extracted evidence to verified PDF coordinates for highlight overlays. Current links open the original page and/or the extracted text line; these are **not PDF bounding boxes**.
6. Add Korean UI and Korean OCR/document cases, accessibility review, and a separate evaluation dataset.
7. Expand operational controls before public deployment: account recovery, email verification, production secrets, HTTPS cookies, backups, monitoring and report font support for Korean text. PDF export currently uses standard Latin fonts.

This tool provides review evidence. It does not certify customs compliance or automatically approve a shipment.
