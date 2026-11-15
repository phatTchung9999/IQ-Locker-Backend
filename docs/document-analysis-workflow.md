# Document upload, extraction, and syllabus analysis

## Implemented: upload and text extraction

1. **Upload.** The material service validates the file and stores the original
   privately in Azure Blob Storage. MongoDB finalization marks the material
   `ready`, creates a `queued` extraction job, and sets the material's
   `processingStatus` to `queued` in one transaction.
2. **Claim.** When extraction is enabled, the extraction worker claims an
   eligible **queued** job, acquires a lease, and marks extraction as
   `processing`. The upload service creates the job; the worker claims it.
3. **Parse.** The worker retrieves the original from Azure and passes the bytes
   to the parser. The parser returns text from supported PDFs and TXT files.
   Scanned PDFs without readable text need OCR, which is outside this workflow.
4. **Save.** The worker calls the extracted text service to store the snapshot
   and its text chunks with PDF page or TXT line references. The results, job
   `ready` state, and material `processingStatus: ready` commit together.
5. **Read.** The owner can retrieve the extracted text through
   `GET /api/v1/courses/:courseId/materials/:materialId/extraction`.
   Follow-up pages must use the returned extraction snapshot ID.

Material `ready` means the **original file is available**. Extraction
`ready` means **extracted text has been saved**. The original remains
available if extraction is paused or fails. See [material storage](material-storage.md)
for configuration, status, retry, and pagination details.

## Implemented: manual analysis queue (Phase 2.2)

Under `/api/v1/courses/:courseId/materials/:materialId/analysis`:
- POST starts a job or returns the existing job for the current snapshot.
- GET returns the current snapshot's job status (404 if not started).
- POST /retry requeues a failed job with fewer than three attempts, preserving
  its attempt count and date context.

All routes are authenticated and require an owned, ready material and ready
extraction snapshot. Start records a UTC reference date. No analysis runs on upload.

## Implemented: opt-in analysis worker (Phase 2.2)

Set `SYLLABUS_ANALYSIS_ENABLED=true` and restart the backend to consume manually
queued jobs. The worker claims a job with a two-minute lease, reads its exact
stored text snapshot from MongoDB, and runs a rules-based analyzer without an
external provider. It verifies quote offsets and checks the owned material and
snapshot again before atomically publishing results under the active lease.
Expired claims can be reclaimed, up to three attempts. Failed jobs can be
retried manually when attempts remain.

The analyzer handles the approved sample formats (plain deadline lines and
pipe-separated schedules), explicit dates, flagged year assumptions, and week
inference when the syllabus defines the calendar. It is not a general PDF table
parser. The worker lifecycle passed against MongoDB with disposable collections and fake blob storage; deployed behavior is unverified.

## Implemented: student review (Phase 2.3)

Students open Analyze syllabus from document actions and can confirm, correct,
or dismiss suggestions alongside their source quotes. Only confirmed dates will appear in Upcoming deadlines.
The status endpoint reports progress; the results endpoint returns suggestions.

### Retrieving pending suggestions

`GET /api/v1/courses/:courseId/materials/:materialId/analysis/results` returns
job and snapshot IDs, material/analyzer versions, and pending suggestions.
Pass `?extractionId=...` from the status response to detect snapshot changes.
Evidence includes the exact quote, chunk offsets, and PDF page or TXT lines.
Reads require ownership and use a consistent MongoDB snapshot. Missing jobs
return 404; unfinished jobs, changed snapshots, or invalid evidence return 409.
A completed analysis with no deadlines returns an empty array.

### Deletion

Once blob cleanup succeeds, the material cleanup transaction removes analysis
jobs and their embedded suggestions for all versions of that owned material,
alongside extraction jobs and text chunks. If cleanup fails, the material remains
inaccessible and cleanup can retry. The worker checks the material and snapshot
under the same course lock before publishing, so a deleted job cannot be recreated
by a late result.

`POST …/analysis/review` accepts `jobId`, suggestion `index`, and `status`
(`confirmed` or `dismissed`). Confirming requires a valid `date` (YYYY-MM-DD).
Decisions are stored separately from original suggestions within the job.
`GET /api/v1/deadlines` returns only confirmed dates belonging to the signed-in
student and current snapshots. No calendar scheduling or reminders are added.

### Schedule table diagnostic

The column-ordered PDF fixture in `src/extraction/schedule-layout.spec.ts`
draws a visually valid Date / Topic / Due schedule. The current parser emits
the dates before the event names and discards their positions; the analyzer
returns no suggestions. PDF text coordinates recover both correct pairings
in this fixture (December 8 → Quiz 1, December 15 → Final exam).

Next, preserve span positions alongside the existing text and citation
offsets, then normalize prose, table rows, and week sections into common event
inputs. Keep ambiguous pairings unresolved. This fixture demonstrates one
failure mode; the reported syllabus has not been compared against its saved
extraction yet.

### Preserved PDF layout

New PDF extractions retain optional text spans on stored chunks. Each span has
page-relative, end-exclusive UTF-16 offsets, the PDF transform, width, and height.
The span is stored once, in the chunk containing its start. It can extend into
the next chunk: reconstruct the page text in chunk order before slicing spans.
The existing flat text, chunk boundaries, and citation offsets are unchanged.
Older snapshots lack spans and need a new extraction to obtain them. TXT and
existing public API responses are unchanged. The analyzer now consumes these spans for supported schedule tables.

### Schedule row normalization

On each PDF page, the analyzer groups horizontal spans by baseline and looks
for a labeled date column (Date, Due Date, Deadline) and event column (Event,
Assessment, Assignment, Due, Deliverable). It pairs aligned cells on the same
row, skipping ambiguous or misaligned rows. Evidence uses the original cells
and header quotes with chunk-relative offsets, including split spans. Prose
and the existing TXT pipe-table format still use the text path.

This initial implementation covers clearly aligned tables with single-span
cells. Wrapped cells, multi-row headings, and schedules continued on pages
without headers are not supported by this layout path.

### Additional schedule layouts

Recognize Schedule, Course Schedule, Course Outline, Syllabus Outline, and Dates
by their text. Font weight is not stored. The PDF paths reset at a new schedule
heading, known policy heading, page boundary, or large row gap. Weekday grids
associate events with dates in the same column. Week tables use the activity
column; a week alone remains unresolved without calendar context. An explicit
exam date in a deliverable takes priority. Inline Dates blocks can hold a finals
window without assuming a day or time. Administrative dates are outside the
current exam/assignment schema.

Tests use simplified recreations, not the original syllabus PDFs. The
Event-before-Date fixture is informed by the Stanford CS230 syllabus layout
(https://cs230.stanford.edu/syllabus/). Arbitrary wrapped cells and section
boundaries still need real-document verification.

### Exam period notices

For a suggested exam range, Confirm period submits `period: true` with no
date to the review endpoint. The backend copies the validated range from the
current suggestion and leaves the exact date and time unset. Upcoming deadlines
shows a muted Exam period notice. Enter exact date opens an empty field; confirming
a day replaces the period decision. Dismissal removes either kind of notice.

Phase 3 calendar: highlight the full inclusive range with a muted color and
an Exam period label distinct from exact exam dates. Calendar rendering remains
future work.
