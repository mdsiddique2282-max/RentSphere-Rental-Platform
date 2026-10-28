# Phase 3 implementation and validation — 2026-10-21

**Implementation delivered and automated tests passed. Phase 3 is not fully
signed off: real Gmail delivery is pending sender/private configuration, and
interactive browser sign-off remains manual.** The user explicitly requested
mock-tested SMTP while the sender is undecided. No real email was sent.

## Implemented and tested

| Module | Result |
| --- | --- |
| Customer dashboard | MongoDB vehicle bookings/property visits, images, dates, amount, fulfilment, creation date, owner decision and customer interest |
| History | Pending, upcoming/active, past/completed and rejected/cancelled groups; completed vehicle labels derived from dates without rewriting historical statuses |
| Cancellation | Customer-only existing cancellation endpoint, persisted statuses, custom confirmation dialog and terminal-transition protection |
| Saved listings | Authenticated save/unsave in MongoDB, atomic deduplication, account isolation, reload persistence and hidden-fixture filtering; anonymous local favourites remain a convenience |
| Owner dashboard | Existing approved-owner publishing/deletion preserved; scoped request inbox, pending/confirmed overview, listing editing, manual availability and vehicle calendars added |
| Owner edits | Title/name, category, location, price, description and image URL; main image updates preserve remaining gallery URLs and do not delete media |
| Owner decisions | Vehicle/property accept/reject; authorization and transaction/CAS concurrency protection; rejection does not reserve dates |
| Admin controls | Availability/calendar added to existing product controls; existing custom deletion, statistics, users and owner review retained; no listing-detail edit controls added |
| Owner access | Existing role + approved profile required; only own listings; no automatic promotion of historical hosts; admin review cannot downgrade an admin or approve an unsubmitted account |
| Vehicle calendar | Actual confirmed booking ranges, manual availability, frontend conflict checks and backend conflict enforcement; no customer information exposed publicly |
| Property interest | Staging customer interest records remain separate from owner acceptance and never automatically rent a property; original isolated-preview behavior retained |
| Forgot Password | Login link, email/reset forms, Nodemailer SMTP adapter, configurable sender, mock transport, expiring hashed tokens, atomic one-time redemption, bcrypt hashing and session revocation |

### Permission and availability rules

- Customers can read their own history, save/unsave their own favourites and
  cancel their own pending/confirmed requests under the existing transition
  policy. Other customers cannot manage those requests.
- Approved owners can publish/manage only their own listings and decide only
  their own requests. User-role historical hosts keep their IDs and ownership;
  they must complete the existing admin-reviewed onboarding to gain management
  permission. No staging account roles were changed by this implementation.
- Admins can manage availability/deletion for any listing and inspect all
  requests. Only the existing designated staging admin remains admin.
- Manual availability uses the existing optional `available` field. It is
  independent of date-specific bookings and never cancels existing requests.
  Availability checks run again inside request transactions.
- Confirmed vehicle bookings block both pickup and return dates. Pending,
  rejected and cancelled requests do not block dates. Future queries exclude
  past ranges. Existing rental pricing/day calculations are unchanged.
- Listing removal preserves booking history. Listings referenced by favourites
  are archived too; save/delete operations share transactional listing locks.
  Admin account deletion refuses to orphan booking or saved-listing references.
- Accepting a property visit does not change property availability. In staging,
  customer interest changes only the visit's separate interest record. Existing
  rental statuses from prior activity are not rewritten or migrated.

## APIs

New endpoints:

| Method and path | Access / behavior |
| --- | --- |
| GET `/api/saved` | Authenticated user's active saved listings |
| PUT `/api/saved/:id` | Authenticated idempotent save; resolves existing legacy aliases |
| DELETE `/api/saved/:id` | Authenticated unsave |
| GET `/api/bookings/owner/requests` | Approved owner's requests; admin can inspect all |
| GET `/api/listings/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD` | Public vehicle calendar; confirmed date ranges only; maximum 366-day query |
| PUT `/api/listings/:id/availability` | Owner/admin; strict `{available: boolean}` body |
| POST `/api/auth/forgot-password` | Validated email; uniform account-neutral response when configured; persistent throttles |
| POST `/api/auth/reset-password` | Valid reset token and chosen password; one-time atomic consumption |

Extended existing endpoints: `PUT /api/bookings/:id/reject` now supports vehicle
requests as well as property visits. Existing confirm/cancel/listing CRUD/owner
review routes are reused. Protected routes reject sessions invalidated by a
password reset. Old JWTs remain compatible for accounts that have not reset.

## Backward-compatible model changes

- `User.savedListings`: optional ObjectId references, excluded from default
  queries; no backfill or existing-record rewrite.
- `User.authVersion`: optional session generation; absent means zero. Incremented
  only when that account successfully redeems a password-reset token.
- New `PasswordReset`: user ID, hashed token, expiry; TTL cleanup.
- New `ResetThrottle`: hashed request buckets, counters and expiry; TTL cleanup.
- Existing listing/booking schemas and account IDs, roles, passwords and
  ownership references were not migrated or rewritten. Manual availability
  reuses an existing listing field.

Reset tokens contain 32 cryptographically random bytes and expire after 15
minutes. Only hashes are stored. Limits: 20 reset requests/IP/15 minutes,
5 requests/email/hour and 20 redemption attempts/IP/15 minutes. SMTP latency is
kept outside the HTTP response path; account-specific delivery failures are not
revealed publicly. Invalid/expired/used tokens cannot change passwords. Successful
redemption revokes older JWT sessions, without changing any other account.

## Files created or modified in Phase 3

Frontend:

- `src/App.jsx`
- `src/components/UserDashboard.jsx`, `AdminPanel.jsx`, `AuthForm.jsx`,
  `BookingModal.jsx`, `PropertyVisitModal.jsx`
- New `src/components/CustomerRequests.jsx`, `SavedListings.jsx`,
  `OwnerRequests.jsx`, `ListingControls.jsx`, `VehicleCalendar.jsx`,
  `PasswordResetForm.jsx`
- New `src/data/useSaved.js`, `requestHistory.js`
- `src/data/detailHeader.js`, `catalog.js` (manual availability presentation)

Backend and configuration:

- `server/server.js`, `server/models/User.js`
- New `server/models/PasswordReset.js`, `ResetThrottle.js`
- New `server/routes/saved.js`, `passwordReset.js`
- `server/routes/auth.js`, `owner.js`, `admin.js`, `listings.js`, `bookings.js`
- New `server/utils/authenticatedUser.js`, `resetEmail.js`
- `server/utils/tokens.js`, `vehicleBookings.js`, `propertyVisits.js`,
  `listingHistory.js`, `previewPropertyWorkflow.js`, `stagingParity.js`
- `server/scripts/dev-staging.js`, `preview-quick-catalog.js`
- `server/.env.staging.example`, `server/.env.example`
- Root/server `package.json` and `package-lock.json` (Nodemailer and compatible
  dependency security updates)

Tests and documentation:

- New `server/test/phase3.integration.test.js`, `phase3-ui.test.js`
- `server/test/staging.integration.test.js` (staging interest no longer rents)
- `server/PHASE3-PLAN.md`, `SMTP-SETUP.md`, this report
- Local verification utilities/logs under `tmp/`; no private credentials stored
  in them. `tmp/verify-phase3-readonly.mjs` makes GET/native-read checks only.

## Verification

- Complete suite: **135 passed, 0 failed, 0 skipped**.
  `tmp/phase3-full-tests.log`.
- Frontend production build: **passed**. `tmp/phase3-final-build.log`.
- Includes API authorization, owner CRUD, request transitions, date overlap and
  double-confirmation races, save/delete races, reload persistence, property
  interest separation, token expiry/reuse/concurrency, hashing, session revocation,
  SMTP failure handling, enumeration responses and rendered UI tests.
- An initial disposable preview-port test encountered Windows EACCES in the
  sandbox. The suite passed outside the sandbox without weakening that test.
- Both dependency audits report **0 vulnerabilities** after compatible fixes.
  Logs: `tmp/phase3-dependency-fixes.log`, `phase3-server-dependency-fixes.log`.
- Read-only staging checks verified dashboard/saved/calendar APIs, role denial,
  hidden smoke fixtures, all 78 migrated identities, existing password hashes,
  ownership, original preview fingerprint and all 154 media files.
  Repeated successfully after a clean final `npm run dev` restart with patched
  dependencies. Frontend remains at `http://localhost:5173`, backend at port 5000,
  exclusively using `rentsphere_staging`. Log: `tmp/phase3-staging-readonly.log`.
- Interest-section markup, original CSS and vehicle WhatsApp builder retain
  their recorded fingerprints. Property WhatsApp templates and gallery markup/
  image URLs are unchanged; only required availability checks were added around
  request submission. No navbar redesign or new CSS framework.

Automated tests use disposable databases. No staging test records were created,
existing staging records were not modified by verification, and no production
database was accessed. No reset, reseed, migration, deployment, real email test,
credential change or automatic role promotion was performed.

## Pending setup and manual browser checklist

**Real Gmail delivery remains pending configuration**, not verified. Sender is
not finalized. Keep SMTP_USER, SMTP_PASS and EMAIL_FROM private and use a Gmail
App Password. See [SMTP-SETUP.md](SMTP-SETUP.md). No credentials were invented or
existing secrets changed. Real email testing requires the chosen sender and a
separate approval; no SMTP connection is made automatically at startup.

Interactive browser automation was unavailable. Rendered UI tests and the build
passed; complete these manual checks for visual/end-to-end sign-off:

1. Log in, refresh dashboards, save a listing, reload and unsave. Verify favourites
   remain account-specific.
2. Review customer request history, dates, amounts, delivery details and status
   groups. Use custom cancellation confirmation on an explicitly chosen request.
3. Using a deliberately approved owner account, verify scoped publishing/editing,
   availability and inbox decisions. Historical user-role hosts must remain
   unprivileged until the normal approval workflow is completed.
4. Verify property visit acceptance and customer WhatsApp interest are separate;
   neither should automatically mark a staging property rented.
5. Verify confirmed vehicle periods on the calendar, pickup/return boundaries,
   conflict errors and manual availability. Existing booking history must remain.
6. Verify admin availability/custom deletion controls and existing users, owner
   review and statistics. Run destructive deletion checks only with isolated
   test fixtures; do not delete existing staging records for testing.
7. Check mobile layout, gallery thumbnails, two-part headers, compact sample
   labels, unchanged interest card and WhatsApp message format. Confirm Phase2
   Smoke listings remain absent from public search.
8. After authorized Gmail setup, test delivery/reset with an explicitly chosen
   account: expiry, invalid/used link, chosen-password login and old-session
   rejection. Do not reset existing admin credentials just to test.

Media remains laptop-hosted. Real SMTP delivery and interactive browser sign-off
are the remaining external/manual limitations. No Phase 4 or deployment work was
started. Stop here pending the user's next instruction.
