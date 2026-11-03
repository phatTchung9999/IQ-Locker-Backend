# In-app notifications

Authenticated endpoints (owner is always derived from the JWT middleware):

- GET /api/v1/notifications — active reminders, unreadCount, nextCursor.
  At most 50 rows; pass ?before=<nextCursor> for older rows.
- PATCH /api/v1/notifications/:id/read — mark one owned active reminder read.
- PATCH /api/v1/notifications/read-all — mark owned active reminders read.

The client refreshes every 30 seconds while visible and on panel open/tab return.
Listing reconciles current conditions into MongoDB notifications:

- Missing school, major or phone: link to profile.
- Account usage at or above 80% of MATERIAL_ACCOUNT_LIMIT_BYTES: link to courses.
- A ready original with failed text extraction: link to its course/folder and
  focus that document's row. OCR limitations receive a specific message.

The unique owner/key index deduplicates profile/storage reminders and each
material/version failure. Read state survives refresh/login. Resolved conditions
are hidden, not deleted; if the same condition returns it retains its read state.
A different material/version gets a new reminder. Titles update on the next poll.
There are no upload-success messages, email, push, OCR or syllabus deadlines.
Reminders are reconciled when requested, not emitted immediately by the worker.
Only safe messages/relative destinations/timestamps/read state are returned;
private blob keys, owner IDs and parser exceptions are excluded. Database source
changes can take until the next poll to appear/disappear. Index creation must be
allowed at deployment, consistent with the existing Mongoose schemas.
