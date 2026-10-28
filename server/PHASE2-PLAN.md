# Phase 2 - staging integration and migration plan

## Approval boundary and current status

Local preparation is implemented. **Approved read-only Atlas verification has
succeeded; no Atlas write or migration has been performed.** Staging is empty,
and its staging-only role and transaction-capable replica-set topology were
verified. Production, Atlas users/permissions, deployment settings and the saved
isolated preview were not modified. Migration still requires separate approval.

## Offline inspection

- Snapshot: **48 listings, 14 users, 16 bookings, 0 owner-document records**.
- No dangling listing hosts or booking user/listing references; all accounts have
  bcrypt hashes, no normalized email collisions, and the records validate against
  the current schemas.
- Original preview roles are **11 admins and 3 users**. The requested migration
  policy now maps only `admin@rentsphere.com` to admin and all other 13 accounts
  to user. Ten roles change only in detached migration copies; the original
  preview, every account ID/hash and all other document fields remain unchanged.
- One listing is archived: preserve all 48 records, while the active catalog
  normally displays 47. Nine legacy listing URL aliases and five recorded
  property-interest decisions must survive migration.
- Thirty listings retain sample/preview metadata and disclosures. Moving them
  into staging does not certify them as real, approved rental inventory.
- All **154 media/upload files** are present. Distinct listing references include
  44 catalog photos, 2 placeholders, 1 local upload and 13 remote URLs. Remote
  availability was not checked. The one listing upload lives only in root
  `uploads/`, whereas the old normal server served `server/uploads/` only.
- Existing root `.env` targets production. It is unchanged and is deliberately
  not used by the new development launcher. Do not run the old seed script.
- The sanitized ZIP cannot preserve real logins: original hashes and personal
  identities must migrate directly from the original private saved snapshot.
  No plaintext passwords need to be known, reset, generated or logged. Native
  inserts avoid Mongoose's password save hook and preserve bcrypt hashes exactly.

## Plan and local implementation

1. **Staging-only configuration.** `npm run dev` retains Vite and the Express
   backend, with a guarded staging launcher. It reads only private
   `server/.env.staging.local` (or explicit process environment), never a fallback
   production URI. Validation pins the supplied cluster hostname, staging
   username and explicit `rentsphere_staging` database, rejects database/host
   override options, and fixes the driver's database name. The normal DB helper
   also rejects unconfigured/production targets before connection.
2. **Offline preflight.** Validate counts, IDs, roles, hashes, unique identities,
   document references, current schemas and every local media reference. Produce
   only aggregate counts and SHA-256 fingerprints. No network is required.
3. **Approved read-only target preflight.** Only after explicit connection
   approval: connect as the staging user, inspect staging collections, verify the
   authenticated readWrite-only staging role and session-capable replica-set or
   sharded topology. This mode uses the native driver without automatic model
   index creation and performs no writes. Unexpected target differences abort.
4. **Separate migration approval.** Present exact insertion/skip counts and a
   target/source/media-bound approval digest. Require fresh approval if the
   snapshot, media or staging data changes. A nonempty target is not overwritten:
   identical IDs/documents are skipped; different records or logical identity
   collisions abort. Existing unrelated staging records are preserved. Existing
   admins outside the sole-admin policy cause an abort, not an automatic update.
   Approval binds the versioned role mapping and full mapped-data fingerprint;
   prior pre-mapping approval digests are invalid.
5. **Backup, insert and verify.** Before any staging writes, create an AES-256-GCM
   encrypted local backup containing the complete original preview state and
   pre-migration staging collections. A separately stored private 32-byte key is
   required. Create required indexes without dropping/syncing existing indexes,
   then insert all missing mapped records in one transaction. Verify that only
   the approved user role fields differ from the original source, then compare
   native target documents against those mapped records and preserve all
   pre-existing target records before commit. Encrypted preview backup retains
   the original roles, not the mapped roles.
   Index creation is itself an approved staging write and is outside the insert
   transaction; if inserts abort, newly created empty collections/indexes can
   remain, but existing records are never overwritten/deleted.
6. **Existing application parity.** Keep UI/CSS/routes and auth/toasts. Normal
   development now projects the same gallery/recommendation/sample presentation,
   resolves legacy URLs, uses database availability instead of stale browser
   status, and mounts the existing customer-interest endpoints. The response
   marker is `catalogContext: staging`; it does not claim Atlas is an isolated
   local preview. Archived listings are not reintroduced by frontend demo arrays.
   Both upload directories are read safely; new uploads use the canonical server
   directory. No existing files are moved, replaced or deleted.
7. **Acceptance after migration.** Use the normal `npm run dev` flow. Re-login
   once using the unchanged email/password; a fresh staging JWT secret means
   existing preview browser tokens are not reused. Verify user/admin access,
   owner onboarding and approved-owner behavior, all active detail URLs, local
   media, filters, visit decisions, vehicle overlap handling, new uploads and
   new-record persistence after backend restart. Existing preview remains a
   separate intact fallback; it is never reset to perform migration.

## Commands and private configuration

Safe to run now, without Atlas access:

```powershell
node server/scripts/migrate-staging.js --dry-run
npm.cmd test --prefix server
npm.cmd run build
```

Prepare `server/.env.staging.local` privately from `server/.env.staging.example`.
It is gitignored. Set `RENTSPHERE_STAGING_URI` using Atlas's staging connection
details, an independent strong `JWT_SECRET`, `PORT=5000`, and
`RENTSPHERE_MIGRATION_BACKUP_KEY` (base64 for 32 private bytes). No actual values
belong in source code, commands, reports, ZIPs or chat. Keep the encryption key
separate from the encrypted backups. The existing `.env` need not be edited.

**Do not execute either of the following until its corresponding explicit
approval has been given.** The fingerprint placeholders below are not secrets.

After approval of a read-only Atlas connection:

```powershell
node server/scripts/migrate-staging.js --inspect-target --approve-connection SOURCE_SHA256
```

Review its staging-only insert/skip counts and approval digest. Then, only after
separate write approval, stop the preview cleanly with Ctrl+C so its last changes
are saved. Re-run offline verification and read-only preflight if the fingerprint
changed. Keep the staging app stopped during migration. Apply the reviewed plan:

```powershell
node server/scripts/migrate-staging.js --apply --approve-connection SOURCE_SHA256 --approve-migration TARGET_APPROVAL_DIGEST
```

Successful output includes aggregate inserted/skipped counts, encrypted backup
location and integrity status, never document contents or connection details.
Then start `npm.cmd run dev`. Running the application allows its ordinary API
writes and model index initialization, so it is also deferred until authorized.

## Backup and recovery

Encrypted backups go to gitignored `server/.staging-backups/` with exclusive file
creation. Format: `RSBK1`, 12-byte IV, 16-byte GCM authentication tag, ciphertext
of an EJSON object containing staging's pre-write collections and the original
preview state (including its JWT key). The encryption key is not stored in the
file. Decryption/integrity was verified with disposable fixtures.

A failed insertion transaction rolls back all inserted documents. Verify the
staging target read-only before retrying; do not reset either database. If a
committed migration later needs reversal, a separately approved restore must
use the encrypted backup and reviewed inserted IDs; no destructive rollback or
automatic database-drop command is included. Original preview state is unchanged.

## Local verification and outstanding work

The complete suite has **112 passing tests** (100 original plus 12 staging
regressions), with zero failures/skips; the production build passes.
The final run and build results are recorded in `tmp/phase2-tests.log` and
`tmp/phase2-build.log`. Regressions cover target guards, offline validation,
approval/encryption gates, exact raw-document/hash preservation, idempotency,
email/data conflicts, transaction rollback, media checks, staging presentation,
legacy aliases, auth/admin/owner authorization, filters, interest decisions and
new users/listings/bookings/visits surviving a database reconnect. Existing tests
continue covering booking conflicts, permission enforcement, private documents,
toasts, uploads and isolated-preview persistence.

Atlas authentication, staging-only role metadata, an empty staging database and
replica-set/session topology have now been verified read-only. Real Atlas write
transaction execution, migration and manual staging browser verification remain
**pending approval**. If role metadata cannot be verified on a later preflight,
the tool stops rather than inferring permissions or changing an Atlas account.

Media are not stored in Atlas by this migration. Vite serves public catalog files
from this checkout, and Express serves authorized uploads from this laptop. These
relative URLs work for local `npm run dev`; another machine needs the same media
bundle or separately approved persistent storage. Remote images still depend on
their original hosts. Private identity documents remain under existing access
controls, not a public static upload mount.

Phase 3-5 candidates remain out of scope: new owner/customer inbox UI, richer
booking history controls, rental offers/agreements, cloud media hosting, distance
tariffs, WhatsApp Cloud API/webhooks, notifications beyond existing toasts and
deployment/production cutover. Existing demo interest behavior remains distinct
from owner visit acceptance and a real rental agreement.

## Files changed for this preparation

- `.gitignore`, `package.json`, `vite.config.js`
- `server/.env.staging.example`, `server/env.js`, `server/db.js`, `server/server.js`
- `server/scripts/dev-staging.js`, `server/scripts/migrate-staging.js`
- `server/utils/stagingConfig.js`, `server/utils/stagingMigration.js`
- `server/utils/migrationMedia.js`, `server/utils/stagingParity.js`
- `server/utils/uploadPaths.js`, `server/utils/uploadImages.js`, `server/utils/ownerDocuments.js`
- `server/models/Listing.js`, `server/models/Booking.js`
- `server/routes/listings.js`, `server/routes/bookings.js`
- `src/data/catalog.js`, `src/App.jsx`
- `server/test/staging.integration.test.js`, this plan and task-only local logs.

No dependencies were added. The user supplied the private staging credential
file; the agent did not change existing credentials or deployment configuration.
See [the sole-admin migration report](./SOLE-ADMIN-MIGRATION-REPORT.md) for the
current exact reviewed insert/skip counts, integrity fingerprints and digest.
