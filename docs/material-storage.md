# Private academic documents (Phase 1.4)

The backend stores document metadata in MongoDB and original files in a private
Azure Blob container. PDFs are rendered client-side with locally hosted PDF.js
assets; TXT content is rendered as text. No extraction/AI analysis runs yet.

## Azure configuration

On the backend App Service, configure:

```env
NODE_ENV=production
AZURE_STORAGE_ACCOUNT_URL=https://iqlockerstorage1904.blob.core.windows.net
AZURE_STORAGE_CONTAINER=materials
MATERIAL_MAX_FILE_BYTES=20000000
MATERIAL_ACCOUNT_LIMIT_BYTES=500000000
```

Also set `JWT_SECRET_KEY` to a strong, unique secret in the backend App Service
environment. Local development reads it from the ignored `.env`. The backend
refuses to start if it is missing or blank. Never reuse the former source-code
key: rotating it invalidates existing tokens, so students must sign in again.
Do not add this secret to frontend variables or commit it.

Set the startup command to `node dist/main.js`. The limits use decimal bytes:
20 MB/file, 500 MB/account. Restart after changing settings. MongoDB must support
transactions (replica set or sharded cluster), as required by the folder feature.

Enable the App Service system-assigned managed identity and grant it
**Storage Blob Data Contributor**, scoped to the private `materials` container.
Keep anonymous blob access disabled. The backend verifies the container is private
before storage operations. No account keys or storage URLs are sent to browsers.

The frontend build still needs `REACT_APP_API_URL` pointing at the backend.
Production frontend packaging must run `npm run build` (including prebuild) so the
version-matched PDF worker, fonts, CMaps, and WASM are copied into `public/pdfjs`.
The generated directory is ignored by Git. Static Web Apps MIME settings cover
`.mjs` and `.wasm` files. The PDF viewer renders pages/canvas and provides zoom;
it does not render PDF annotations, embedded JavaScript, XFA, or external links.

## Verify access after deployment

From the deployed backend's SSH console, in the application directory:

```sh
npm run storage:check
npm run storage:check -- --roundtrip
```

The first command only checks private-container access. The second uploads,
reads and deletes a uniquely named disposable blob under `phase14-check/`.
It does not touch existing material records or student files. Package `scripts/`
alongside `dist/` and the production dependencies to use this command.

Cloud-managed-identity access cannot be inferred from local mocks. The local
workspace did not have storage configuration/developer credentials during
implementation; this deployment check remains necessary.

For local development, use an Azure developer login with container data access,
or set `NODE_ENV=development` and `AZURE_STORAGE_CONNECTION_STRING` to a local
Azurite connection. Connection-string mode is disabled unless NODE_ENV is
explicitly development or test. Keep credentials out of Git and frontend variables.

## Document endpoints

All endpoints require the existing Bearer token and use the authenticated owner.

- `GET /api/v1/courses/:courseId/materials?folder=:folderId`: direct documents and
  account-wide quota/limits. Omit folder for course root.
- `POST` on the same path: multipart `file` (one PDF/TXT), optional `title` field.
- `GET /api/v1/courses/:courseId/materials/:materialId`: safe metadata.
- `PATCH` on that path: `{ "title": "New display title" }` only.
- `DELETE` on that path: delete original blob, metadata and quota reservation.
- `GET .../:materialId/content`: authorized stream; add `?download=1` for download.

Files must be nonempty PDF or valid UTF-8 TXT. Extension and declared MIME are
checked against actual content. Encrypted, malformed, empty, and >1,000-page PDFs
are rejected. Binary/invalid-UTF-8 text is rejected; markup in TXT remains inert.
The initial classification is inherited from the nearest classified ancestor,
otherwise blank. Version 1 and processingStatus `not_started` are reserved for
future extraction. Original bytes/filename remain unchanged when titles change.

## Consistency, quota and recovery

Upload flow: authorize/validate -> reserve quota and pending record in a database
transaction -> private blob upload -> finalize ready metadata -> safe response.
The durable reservation is internal bookkeeping before Azure I/O; it ensures every
possible blob has a recoverable storage key, including after crashes. No Azure I/O
is performed inside a MongoDB transaction.

Course revision writes serialize reservations with folder/course deletion.
Account usage revision writes serialize quota checks across different courses.
All pending uploads/deletions count toward the account quota. Parent deletion
checks all document states, including pending operations. Existing starter folder
protections remain intact; courses with documents cannot be deleted.

A per-process recovery sweep runs every minute, with database-backed cleanup
leases coordinating multiple server instances. It processes up to ten records per
sweep. Failed/ambiguous uploads wait three minutes for network operations to settle;
abandoned uploading records expire after fifteen minutes. Failed deletes retry
after one minute; leases last three minutes. Quota is released only in the same
transaction that removes metadata, after idempotent blob deletion succeeds.

A failed delete leaves an inaccessible pending record and returns an error;
refresh/retry cleanup is available in the UI. Do not manually delete journal rows
or reset usage counters: that can break cleanup/accounting. Do not enable MongoDB
TTL expiry on these records. Keep the app running for scheduled retries; after a
restart the persisted recovery work resumes. Azure permissions/storage outages
must be fixed before cleanup can complete.

## Verification

```sh
npm test
IQLOCKER_MONGO_TEST=1 npm test
npm run build
```

Default tests use an isolated in-memory storage adapter and repository. HTTP tests
exercise actual multipart handling, authentication, private streams and size limits.
Opt-in MongoDB tests use uniquely named disposable collections, fake owners and an
in-memory blob adapter, and clean up only their own collections. They verify real
transactions, quota races, parent deletion races, persistence and recovery. Azure
SDK adapter tests verify identity selection, private-container checks, safe errors
and transfer options. They do not replace the cloud round-trip command above.

No OCR, full-content search, replacement/version UI, AI classification or generated
quizzes/reminders is implemented in this phase.
