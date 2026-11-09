# Private avatar service

This backend slice connects the reserved User.avatarKey to the private Azure
avatars container. The frontend now fetches the saved image once per workspace
and shares its object URL between the profile and sidebar. Selecting/dropping a
photo creates a local preview; Save photo uploads independently of profile text
changes. Remove photo deletes the saved avatar; initials are the fallback.
Loading, upload/removal errors and authenticated reload are supported. Blob URLs
are revoked on replacement/logout/unmount; stale requests are aborted. A failed
refresh after a successful upload offers reload without uploading again.

## Authenticated endpoints

All routes use the existing JWT middleware. The owner comes from req.user._id;
there is no user ID, storage key or container parameter accepted from clients.

- POST /api/v1/user/me/avatar — multipart field `file`, one JPG/PNG/WebP,
  up to 5,000,000 bytes; 200 `{ "hasAvatar": true }`.
- GET /api/v1/user/me/avatar — authenticated image/webp stream; 404 when absent.
- DELETE /api/v1/user/me/avatar — remove current avatar; 204, also when absent.

Content is private/no-store, nosniff, with a fixed safe filename. Private blob
keys are never returned. User/profile JSON responses stay unchanged. A browser
client must fetch with its Authorization header and display a temporary object
URL; a plain public blob URL or img src cannot supply the Bearer header.

## Image processing

Pinned production dependency sharp decodes actual pixels rather than trusting
filenames. The MIME type must match the detected JPEG, PNG or WebP format.
Scanned images are fine; animated/multi-page images, SVG, corrupt/truncated files,
inputs above 5 MB or 16 million pixels are rejected. Images are auto-oriented,
center-cropped to 512x512 and re-encoded as WebP, dropping original metadata.
There is a 10-second image-processing timeout and at most two simultaneous
avatar uploads per backend instance, one per user per instance.
Official API references: https://sharp.pixelplumbing.com/api-constructor/ and
https://sharp.pixelplumbing.com/api-output/.

## Storage and publication

Workflow: validate/re-encode -> private avatars container check -> durable Avatar
upload journal -> Azure upload -> MongoDB transaction activates the journal and
compares/replaces User.avatarKey -> old asset enters cleanup -> remove old blob.
The original avatar remains referenced until the new image is stored and the
transaction commits. Competing changes return 409 instead of overwriting a newer
avatar. Originals use random generated keys and never overwrite an existing blob.

User.avatarKey remains the current owner association. The additional Avatar model
is a blob lifecycle journal, not a replacement account/profile model. It tracks
owner, key, normalized size, state, retry time and cleanup lease. Unique keys and
owner/state plus state/retry indexes support bounded cleanup.

Failed/abandoned uploads and retired images are journaled for recovery. Cleanup
runs at startup, every 60 seconds and after mutations, at most ten items per pass.
Unfinished uploads expire after five minutes (longer than the storage timeout).
Cleanup failures retain their records and retry later. A three-minute token lease
coordinates cleanup across instances. Current User references are checked before
blob deletion; an uncertain commit cannot cause the active image to be deleted.
No TTL drops records before blob cleanup. Avatar bytes do not consume the academic
material quota, and original unprocessed photo bytes are not retained.

## Deployment and checks

Use the same account/authentication as materials, with
AZURE_STORAGE_AVATARS_CONTAINER=avatars and private container access. Grant the
backend managed identity and local developer the required container data role.
MongoDB transactions require a replica set, as existing material workflows do.
Install production dependencies on the target platform: sharp has native runtime
binaries; do not copy macOS node_modules to Azure Linux. Backend startup remains
node dist/main.js. Recovery needs the backend process running.

Local isolated validation:
`npm test -- src/dto/avatar.dto.spec.ts`
`IQLOCKER_MONGO_TEST=1 npm test -- test/avatars.mongo.spec.ts`
The latter uses disposable MongoDB collections and fake blobs, not student data.
Live deployed upload/download/delete and native Linux sharp loading remain to be
verified after deployment. No settings, permissions or real avatar data were
changed during implementation.

## Avatar icon actions and rotation

Clicking a saved profile photo (or its camera control) opens Rotate, Change and
Delete icon actions with accessible labels/tooltips. Enter and Space open it too.
Change opens the upload box; the format/size hint is inside the drop area.
Rotate previews another 90 degrees clockwise locally; Save photo persists it and
Discard restores the saved image. The sidebar changes only after saving.

POST /api/v1/user/me/avatar optionally accepts one multipart `rotation` field:
0, 90, 180 or 270. Other fields/angles are rejected. The file is still mandatory;
the client supplies the authenticated saved image or its selected new photo.
Sharp normalizes EXIF orientation before applying the explicit clockwise rotation.
Existing ownership, validation, private storage, publication and cleanup apply.
Deploy the updated backend before using rotation from the updated frontend.
