# Private academic documents (Phase 1.4)

The backend stores document metadata in MongoDB and original files in a private
Azure Blob container. PDFs are rendered client-side with locally hosted PDF.js
assets; TXT content is rendered as text. Optional backend text extraction is
implemented through Phase 1.5 Step 4; AI analysis is not implemented.

## Azure configuration

On the backend App Service, configure:

```env
NODE_ENV=production
AZURE_STORAGE_ACCOUNT_URL=https://iqlockerstorage1904.blob.core.windows.net
AZURE_STORAGE_MATERIALS_CONTAINER=materials
AZURE_STORAGE_AVATARS_CONTAINER=avatars
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

Cloud-managed-identity access cannot be inferred from local tests. A local Azure
storage round trip passed on October 30; deployed identity/browser verification
remains a separate acceptance check.

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
otherwise blank. New materials use version 1 and transition from `not_started`
to `queued` when file finalization and extraction-job creation commit together. Original bytes/filename remain unchanged when titles change.

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

## Phase 1.5: reliable extraction jobs

Successful uploads now finalize the ready material, its owned material/version
extraction job, and queued processing status in one MongoDB transaction. An
enqueue failure rolls back readiness and follows the existing upload cleanup
path. The existing recovery timer catches up at most ten ready/not_started
PDF/TXT materials each minute and at startup, with ownership and state rechecked
inside a course transaction. Material deletion removes jobs transactionally with
metadata/quota cleanup. Existing private file access is unchanged.

The backend worker and private text writer are implemented, but processing is
disabled by default. Jobs remain queued unless explicitly enabled. OCR and AI
analysis are not implemented. Processing status/retry UI is implemented in Step 5. No extra Azure service
is required for this initial MongoDB-backed queue.

## Phase 1.5: optional background extraction

The backend now includes a MongoDB-leased dispatcher and a Node worker-thread
PDF/TXT parser, with PDF.js pinned as a production dependency. Keep:

```env
EXTRACTION_PROCESSING_ENABLED=false
EXTRACTION_MAX_INPUT_BYTES=20000000
EXTRACTION_MAX_TEXT_CHARS=2000000
EXTRACTION_TIMEOUT_MS=60000
```

Step 4 supplies the transactional source-text writer. The default false setting
keeps processing off. After validating configuration and deployment, explicitly
set `EXTRACTION_PROCESSING_ENABLED=true` and restart to process queued documents,
including existing catch-up jobs. No real student processing was enabled during
implementation. Start with disposable documents in a test environment.

The enabled worker polls every five seconds, handles one task per backend
instance, uses 180-second claims with 30-second renewal, and recovers at most ten
expired claims per pass. Storage/timeouts have bounded retries; image-only/empty
text and parser/output-limit failures are reported separately. Original file
access and upload cleanup remain independent of extraction success.

PDF/TXT parsing is in a separate thread with heap/time/output limits; threads are
not an OS security sandbox and do not impose a complete native-memory ceiling.
PDF text retains page references; TXT preserves its text for later line/character
chunking. OCR is not supported. Parser diagnostics/document text are not logged.

Use `npm run build` so Nest copies `src/extraction/parser-worker.mjs` into
`dist/extraction/`. Deploy that file and production dependencies along with the
compiled backend. `npx vitest run src/extraction` runs parser/gating/watchdog tests;
`IQLOCKER_MONGO_TEST=1 npm test` includes disposable MongoDB lease/recovery tests.

## Private source-linked text (Phase 1.5 Step 4)

`extractedtexts` stores extraction manifests and `extractedtextchunks` stores text
in chunks of at most 4,000 UTF-16 code units, bounded by 2,000 chunks and the
configured total text limit. Each includes owner/course/material/version and
extractor version. Unique indexes protect each material/version snapshot and
snapshot/chunk index. These are internal collections, not public static assets.

PDF chunks refer to a 1-based page and exclusive-end character offsets within
that page's extracted text. TXT chunks use offsets within the decoded file and
1-based inclusive start/end line numbers. CRLF counts as one line ending. Unicode
surrogate pairs and CRLF pairs are not split across chunk boundaries. PDF reading
order is parser-derived; exact visual layout/table semantics are not guaranteed.

The writer revalidates material ownership/version/state and a live lease inside
the worker's course transaction. Manifest/chunks, ready job status and ready
material processing status commit together. Partial writes roll back. Retried
writes replace the same version atomically; original file bytes remain unchanged.
Deletion removes all versions of derived text with jobs/metadata/quota cleanup.
Pending deletion immediately blocks new extracted-text reads. Parsed text is
untrusted data; it must never be treated as instructions or authorization.

Authenticated API:

```text
GET /api/v1/courses/:courseId/materials/:materialId/extraction
GET /api/v1/courses/:courseId/materials/:materialId/extraction?offset=20&extractionId=SNAPSHOT_ID
```

The first response includes snapshot/material/version IDs, extractor version,
chunk count, text length, page count, extraction timestamp, up to 20 chunks and
`nextOffset`. Follow-up requests must include the returned `extractionId`; if it
changes, restart from the first chunk. Source text is JSON with private/no-store
headers. Queries always include the authenticated owner/course/current version.
No storage keys, lease tokens, raw parser errors or owner records are returned.
Returns 401 without authentication, 404 for foreign/missing references, 409 if
not ready or the snapshot changed, and 400 for invalid IDs/offsets.

### Future analysis retrieval contract

- Selected folder: direct documents by default; descendant inclusion must be an
  explicit option. Folder IDs must belong to the authenticated owner/course.
- Selected course: include root documents and all descendant folders.
- Select only available originals with ready extraction; preserve material IDs,
  versions, extraction snapshot IDs, extractor versions and chunk references in
  each analysis request so citations are reproducible. Do not silently analyze
  missing/failed documents as if the selection were complete.
- Folder material type is context independent of the display name. Document text
  cannot broaden this scope. No folder/course analysis or search API exists yet.

Validation uses isolated MongoDB collections, fake blob storage and real parsers
for TXT/PDF round trips, privacy, bounded pagination, source fidelity, rollback,
idempotence and stale/deleted results. Live Azure and deployed worker checks remain
separate from these tests. Processing-status/retry controls are implemented in Step 5, described below.

## Processing status and retries (Phase 1.5 Step 5)

Owned list/read responses include `processingStatus`, safe `processingErrorCode`,
`processedAt`, `processingAttempts`, `processingMaxAttempts` and
`canRetryExtraction`. List responses additionally include `processingEnabled` so
clients do not poll a paused worker. Job details are fetched in one scoped batch
for the folder list; blob keys, lease tokens and provider exceptions stay private.

```text
POST /api/v1/courses/:courseId/materials/:materialId/extraction/retry
Authorization: Bearer TOKEN
```

No request body is needed. Returns 200 with safe updated material metadata and
private/no-store headers; 401 for missing authentication, 404 for foreign/missing
references, 400 for invalid IDs and 409 when retry is not eligible. Owner is
always derived from authentication. The material must be available and both its
processing status and current-version job must be failed.

Eligible error codes are parser_failed, timeout and storage_unavailable, with
attempts remaining. No-readable-text, output-limit and attempts-exhausted jobs
cannot be manually retried in this slice. The lifetime attempt budget (default
3) includes automatic and manual attempts: retry requeues the same job and clears
its failure/lease/timestamps, but never resets attempts or increases maxAttempts.
The worker increments attempts when claiming work. Concurrent repeated retry
requests can queue once; later requests conflict rather than create duplicate
jobs. Material and job status changes share the course transaction.

The document UI displays Awaiting extraction, Queued, Extracting, Text ready or
Failed with safe explanations. It offers a retry button only when the server
allows it. Original previews/downloads remain available during extraction or
after extraction failure. Scanned documents explicitly explain the OCR limitation.

Active processing refreshes every five seconds without hiding document rows.
Polling stops on completion, disabled processing, navigation/unmount, authorization
failure or refresh errors; hidden tabs pause and resume on visibility. A refresh
error preserves the document list and offers an explicit Refresh action. Queued
work with processing disabled shows a paused message instead of endless polling.
The UI does not yet display extracted-text chunks or provide an Analyze action.

Default processing remains false; implementation/testing did not enable student
processing or change Azure settings. Final desktop/mobile browser review and live
Azure/deployed workflow verification remain Step 6.


## Separate avatar container

Materials and avatars share AZURE_STORAGE_ACCOUNT_URL and authentication, but use
separate private containers. Existing storage calls default to materials. Future
avatar persistence can use the same service with the server-selected kind:

```ts
await storage.ensureReady('avatars');
await storage.upload(key, imageBytes, mediaType, signal, 'avatars');
await storage.download(key, signal, 'avatars');
await storage.remove(key, 'avatars');
```

No avatar upload endpoint/profile persistence is added by this configuration step.
Each container has its own private-access check/cache. Missing avatar config does
not break materials; avatar operations never fall back to the materials container.
AZURE_STORAGE_CONTAINER remains a legacy fallback only for materials; the new
AZURE_STORAGE_MATERIALS_CONTAINER takes priority. Rename the setting in Azure on
next deployment and add AZURE_STORAGE_AVATARS_CONTAINER=avatars. No new secrets.
Grant the backend identity and local developer appropriate data access to avatars.
Restart the backend after configuration changes (container clients are cached).

Check access without writing: `npm run storage:check` and
`npm run storage:check -- --avatars`. Add `--roundtrip` to either command for a
disposable upload/download/delete test in that selected container.

## Startup diagnostics

main.ts pings the connected MongoDB database, then checks private access to both
configured containers in parallel. Successful checks log MongoDB connected and
Materials/Avatars container private access verified. Container failures emit a
redacted warning and do not prevent the backend from starting. MongoDB ping or
HTTP listening failures close the app and set a failing exit code. The listening
message is printed only after app.listen succeeds and includes the bound port.
These are point-in-time startup checks, not continuous monitoring or evidence of
upload/delete permissions. Container checks read properties; they never upload.
