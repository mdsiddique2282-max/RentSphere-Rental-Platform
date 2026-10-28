# Sole-admin migration preparation

Subsequently applied with explicit approval on 2026-10-20. See
[STAGING-MIGRATION-RESULT.md](STAGING-MIGRATION-RESULT.md) for verified results.
The preparation notes below describe the state before that approval.

Implemented and tested locally. **No Atlas writes, migration, original preview
role changes, development-server startup, production access or deployment.**

## Intentional role policy

Only `admin@rentsphere.com` will be admin in the migrated data. All other 13
existing accounts will be users. This changes ten role fields in migration
copies: source roles are 11 admins / 3 users; target roles are 1 admin / 13 users.

The migration clones the source using BSON/EJSON. It changes only each copied
user's `role`; all account IDs, emails, password hashes, profiles, timestamps,
listings, bookings, document records and ownership/reference fields remain
identical. Integrity checks reject any additional change. The original snapshot
is never written. Its encrypted recovery backup retains its original roles.

If staging already contains unmapped admins or conflicting records, migration
aborts rather than updating roles or overwriting data. Identical mapped records
are skipped on rerun. No account is created merely to satisfy the admin policy:
a missing or ambiguous existing designated admin stops preflight.

Nine existing listings have hosts whose copied roles will become user. Their
ownership remains intact; the existing ordinary-user publishing/management
restrictions will apply. The sole admin can still manage those listings. No
authorization bypass or automatic owner-role grant was introduced.

## Exact read-only Atlas plan

Authentication and the staging user's sole `readWrite` role on
`rentsphere_staging` passed. Replica-set/session topology supports transactions;
no Atlas write transaction was executed. Staging still has **zero collections
and zero documents**.

| Collection | Existing | Insert | Skip | Update/delete |
| --- | ---: | ---: | ---: | ---: |
| users | 0 | 14 | 0 | 0 |
| listings | 0 | 48 | 0 | 0 |
| bookings | 0 | 16 | 0 | 0 |
| ownerdocuments | 0 | 0 | 0 | 0 |
| Total | 0 | 78 | 0 | 0 |

All 48 listing records are retained, including the archived listing; the active
catalog remains 47 listings. All 154 media/upload files remain present and are
not copied into Atlas or changed by the role-mapping operation.

## Approval identity

Plan version: `staging-migration-sole-admin-v1`.

The digest binds the original snapshot, media inventory, existing target data,
insert/skip counts, sole-admin identity/policy, role totals and mapped-data hash.
Prior pre-mapping digests cannot authorize this plan. Any relevant change
requires a fresh preflight and approval.

- Source snapshot SHA-256:
  `19a25e96565ff6c38853287f7e3d2f371bf1ca50f7fcac2a5f9ae85d3dd4e711`
- Original collection data SHA-256:
  `18316dc74524d8acbb08cc2181713c72c6317762d341ab1da751360afa3293b7`
- Mapped migration data SHA-256:
  `e8e96908a80e65594c5926d3571c289670f3022f36a513b7c67a47045e8cae73`
- Media inventory SHA-256:
  `bf8de253ec30d1e572a97a27c68f8daeafb8ecac74f26c573325fb0ebef64e32`
- Empty target data SHA-256:
  `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`
- **Approval digest:**
  `430e92dc5e3251752a2ec9d9601ca3880523ea0ed3558de9e1ab08ae82ebdc19`

These are fingerprints, not credentials. No URI, password, JWT key or backup
encryption key is included in this report.

## Verification

- `npm.cmd test --prefix server`: **112 passed, 0 failed, 0 skipped**.
- Focused staging suite: **12 passed**.
- `npm.cmd run build`: **PASS**.
- Offline dry-run shows the role mapping without any network connection.
- Disposable local migration proves exact preservation except approved role
  changes, encrypted original-state recovery, idempotent reruns, collision
  refusal, transaction rollback and rejection of old/tampered approvals.
- All 14 fixture accounts log in with the same chosen password after migration;
  all retain IDs. Only the designated account accesses admin APIs; all other
  accounts are denied admin access. No existing owner authorization rule changed.
- The real snapshot's before/after fingerprint and media fingerprint agree.
- Existing preview and authentication/toast regressions continue passing.

Modified files: `server/utils/stagingMigration.js`,
`server/scripts/migrate-staging.js`, `server/test/staging.integration.test.js`,
`server/PHASE2-PLAN.md` and this report. Local logs/dry-run output are under `tmp/`.

## Awaiting separate approval

The approved next action would create an encrypted local recovery backup,
create required staging collections/indexes, then insert 14 users, 48 listings
and 16 bookings with the sole-admin mapping in a transaction. It would verify
the mapped data and preserve all originals. It would not update/delete existing
records, alter the original preview or access production.

**That operation has not been run.** Before applying it, stop preview cleanly
with Ctrl+C so all changes are saved; the agent will not stop/reset it silently.
The script refuses an active preview lock and rejects changed source/target/media
fingerprints. No `npm run dev` is started automatically by migration.
