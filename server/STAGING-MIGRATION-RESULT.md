# Approved staging migration — 2026-10-20

Completed exclusively in `rentsphere_staging` using the approved sole-admin mapping.

| Collection | Inserted | Skipped | Verified final count |
| --- | ---: | ---: | ---: |
| users | 14 | 0 | 14 |
| listings | 48 | 0 | 48 |
| bookings | 16 | 0 | 16 |
| ownerdocuments | 0 | 0 | 0 (collection absent) |

The 78 inserts committed in one replica-set transaction with snapshot reads and
majority writes. No existing documents were updated or deleted. Required indexes
were created and independently checked: users `email_1`; bookings
`listing_1_status_1_startDate_1_endDate_1`, `requestId_1`, `submissionKey_1`;
all three populated collections also have `_id_`.

Only `admin@rentsphere.com` has the admin role; all other 13 accounts have the user
role. Native BSON comparisons verified every migrated document against the
approved mapped source. IDs, password hashes, all non-role fields, listings,
bookings and ownership references were preserved. The original preview retains
its original roles and its exact approved snapshot fingerprint.

## Encrypted recovery backup

File: `.staging-backups/staging-before-1792515316785-2caea670f3ba.enc`

Size: **109,684 bytes**. AES-256-GCM authenticated encryption. Contains the empty
pre-migration staging snapshot and the original preview collections, including
original roles and recovery metadata. The key remains in private local
configuration and is not included in this report or the backup.

The saved backup was read, decrypted, authenticated and compared with its expected
contents **before index creation or inserts**, and checked again after commit.
Keep this encrypted file and the private backup key securely; restoration needs
both. This database recovery backup does not embed media files.

## Verification

- A separate read-only connection verified final counts, exact mapped records,
  sole-admin roles, staging-only authenticated permissions and required indexes.
- An idempotency inspection produces **0 inserts / 78 skips**; no second migration
  was applied.
- Original preview snapshot SHA-256 remains
  `19a25e96565ff6c38853287f7e3d2f371bf1ca50f7fcac2a5f9ae85d3dd4e711`.
- All **154 media/upload files** remain unchanged; media SHA-256 remains
  `bf8de253ec30d1e572a97a27c68f8daeafb8ecac74f26c573325fb0ebef64e32`.
- All **12 focused staging tests passed**, including backup tampering/wrong-key
  rejection, rollback, insert-only behavior and staging router functionality.
  The earlier full suite passed 112 tests and the production build passed;
  these were not rerun for this migration execution.
- No production database access, deployment, push or development-server startup
  was performed. Browser testing against Atlas remains pending separate approval.

Stopped after verification, awaiting approval for the next step.
