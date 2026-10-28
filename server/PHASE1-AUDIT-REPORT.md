# Phase 1 audit fixes - 20 October 2026

All nine audit issues are fixed in the existing project. The complete nine-page
audit was read before implementation, including pages 4, 5, 8 and 9. Its broader
roadmap was treated as evidence, not authorization to start Phase 2.

| Issue | Status | Root cause and correction |
| --- | --- | --- |
| A01 | FIXED | Admin GET handlers seeded listings and returned invented fallback records/counts. Removed read-side seeding and fabricated API/UI results. Counts include true zero values; read failures return errors. |
| A02 | FIXED | Owner registration stored original casing while login searched lowercase only. Both registrations now canonicalize email and reject case-equivalent duplicates. Login finds legacy mixed-case accounts without rewriting them; collisions use exact registered casing or a single matching password, with 409 for ambiguous matches. |
| A03 | FIXED | Search overwrote the category `$or`. Type, category/kind and literal text search now intersect using independent predicates. Query failures return 503. |
| A04 | FIXED | Normal request creation ignored property status. Both generic property requests and visits now reject rented/unavailable properties, checking again inside a transaction sharing the listing write lock. Draft/archived listings cannot accept requests. |
| A05 | FIXED | Confirm handled only vehicles and no visit rejection API existed. Added authorized transactional visit confirmation/rejection and an owner-scoped visit inbox API. Existing vehicle confirmation and customer cancellation remain. Accepting a visit does not rent the property. |
| A06 | FIXED | Create converted price without validating it. Create now rejects negative, missing, empty, non-finite and invalid input; the Listing schema enforces finite non-negative prices. The existing strict update allowlist remains enforced. Zero remains valid. |
| A07 | FIXED | Hard deletion left surviving bookings with a null listing. Referenced listings now archive, retaining their IDs, details, images and populated booking references. Unreferenced deletion remains available. User deletion refuses accounts with booking history and never deletes bookings. |
| A08 | FIXED | Registration required only non-empty strings. Both registration APIs enforce email syntax, non-blank names/passwords and passwords of at least six characters, at most 72 UTF-8 bytes (bcrypt limit). Login retains compatibility with existing short passwords; no password hashes were changed. |
| B01 | FIXED | Auth initialized to null, so dashboard effects redirected before storage hydration. Auth now reads the existing stored session in the state initializer, before the first child render. |

## Files modified in this task

Existing project files:

- `server/models/Listing.js`
- `server/routes/admin.js`
- `server/routes/auth.js`
- `server/routes/bookings.js`
- `server/routes/listings.js`
- `server/routes/owner.js`
- `server/utils/workflowPolicy.js`
- `src/components/AdminPanel.jsx`
- `src/context/AuthContext.jsx`
- `server/PHASE1.md`

Added implementation and regression files:

- `server/utils/accountValidation.js`
- `server/utils/listingHistory.js`
- `server/utils/propertyVisits.js`
- `server/test/phase1Audit.integration.test.js`
- `server/test/authHydration.test.js`
- `server/PHASE1-AUDIT-REPORT.md`

Task-only inspection scripts, logs and integrity fingerprints are under `tmp/`.
The working tree already contained substantial preview/catalog/workflow edits;
those were preserved and are not claimed as work performed by this task.
No dependencies, credentials, environment files, CSS, layouts or frontend routes
were changed by this task.

## Verification

- `npm.cmd test --prefix server`: **95 passed, 0 failed, 0 skipped**.
  All 83 pre-existing tests pass, plus 12 new regressions covering the nine issues.
- `npm.cmd run build`: **PASS**, Vite production build (39 modules).
- Integration tests mount the normal routers directly, avoiding preview wrappers
  that could hide production-route defects. Every database used by these tests
  is a newly created disposable local MongoDB replica set; no production env or
  configured database URI is loaded.
- Regression coverage includes legacy case collisions with unchanged account
  IDs/hashes/roles, owner/admin authorization, visit terminal states and concurrent
  decisions, price/input validation, archived history and concurrent request/removal.
- B01 is verified by rendering the real AuthProvider: valid user, owner and admin
  sessions exist on the very first render; invalid legacy sessions are discarded.
  A new manual browser refresh/end-to-end run was not performed.
- Existing tests also verify vehicle overlap transactions, pricing, INR 300
  delivery, private documents, uploads, WhatsApp handoffs and preview restarts.
- Final logs: `tmp/phase1-tests.log`, `tmp/phase1-build.log`.

The first verification run exposed an existing save-failure test that the new
transactional save path bypassed. The implementation was corrected to retain
the tested save behavior; no existing test was removed or weakened. A new test
initially used the wrong Vite root and was corrected. The final complete run has
no failures.

## Existing preview data and UI preservation

The saved preview state was inspected read-only, without starting/resetting that
preview or connecting to its database. Before/after fingerprints agree:

- **47 listings, 47 unique IDs**.
- **14 users and 14 bookings** retained.
- Saved state SHA-256:
  `f7e12653336f94b09be8a88318d4d826e3e53c6b5cda8e405296d4410893c8d9`.
- **146 files** under `public/catalog-media` and `public/catalog-placeholders`;
  every before/after file SHA-256 agrees. Existing photo decode/credit tests pass.
- Fingerprints: `tmp/preview-integrity-before.json` and
  `tmp/preview-integrity-after.json`.

No existing preview account, role, password, listing, image or booking was changed
or reset. No live Atlas connection, migration, deployment or GitHub push occurred.
The existing frontend design, markup layout, CSS and routes were retained;
frontend changes only repair session initialization and admin data/error handling.

## Remaining risks and limits

- Transactional request creation, visit decisions and safe removal require a
  MongoDB replica set or sharded cluster. Failures return errors; they do not
  fall back to unsafe writes. Verification used disposable local replica sets.
- Existing case-colliding accounts are preserved, not merged. An ambiguous login
  requires exact registered email casing. Any future merge/identity migration
  needs separate approval.
- Listing archival is additive and lazy: only a future authorized removal of a
  referenced listing adds `archivedAt`. No migration/backfill was run. Previously
  lost references are not reconstructed.
- A05 adds backend APIs only. No owner dashboard redesign, rental offers,
  notifications, vehicle rejection feature or external messaging integration was
  added. Existing preview customer-interest behavior remains separate.
- Atlas behavior and full browser/device/accessibility testing remain unverified.
  Phase 2 and Atlas migration were not started.
