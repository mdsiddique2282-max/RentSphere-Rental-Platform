# Phase 1: backend security and workflow foundation

## Permissions and compatibility

The user explicitly approved requiring approved owners/admins after being told
that this disables the previous ordinary-user demo publishing behavior.

- Publishing requires an admin, or `role: owner` with
  `ownerProfile.status: approved`, read from MongoDB on each request.
- Editing, deleting, and marking a property rented additionally require listing
  ownership; admins may manage any listing. Vehicle confirmation uses the same
  approval requirement plus listing ownership/admin access.
- Ordinary users and pending/rejected owners may still browse, authenticate,
  access their existing dashboard, and follow the existing onboarding process.
  Their existing upload controls now return a clear 403 until approved. There
  were no UI changes. Existing owner/user records were not upgraded or changed.
- Listing type, host, IDs, role, verification, rating, timestamps, version and
  bookingRevision cannot be assigned through the listing update API. Unknown
  fields cause 400; a mixed valid/protected payload is rejected in full.
- Editable fields: title, name, category, location, price, description, image,
  gallery, amenities, features, bhk, area, furnishing, floor, availability,
  status, fuel, transmission, seats, badge. Scalar/array types are checked.
  Setting status also sets the matching availability label; only properties may
  be marked rented. Listing type cannot be changed to bypass vehicle safeguards.
- Listing writes must complete in MongoDB before success is returned. Temporary
  synthetic listings and their stale in-process cache were removed. Built-in
  frontend sample listings and all routes remain. On uncertain database failures,
  reload before retrying; a write may have committed before connectivity failed.
- Updating/deleting a concurrently changed listing returns 409. Missing listings
  return 404; repeated rent requests return 409. No data migrations were run.
  The audit fixes add optional listing archival and schema price validation.

## Request transition policy

| Current | Next | Actor |
| --- | --- | --- |
| pending | confirmed | Approved listing host or admin |
| pending | rejected | Approved listing host or admin |
| pending | cancelled | Request's customer |
| confirmed | cancelled | Request's customer |
| confirmed | confirmed | Same authorized decision actor; idempotent retry |

All other transitions, including revival of terminal requests, are rejected.
Cancellation is an atomic compare-and-set. Vehicle confirmation retains the
shared listing write lock and MongoDB transaction to serialize overlapping
confirmations. MongoDB transactions require a replica set or sharded cluster.

The shared policy now governs vehicle confirmations and persisted property visits.
`GET /api/bookings/owner/visits` provides an approved-owner-scoped inbox (admins
can inspect all visits). `PUT /api/bookings/:id/confirm` accepts visits or retains
the existing vehicle confirmation behavior. `PUT /api/bookings/:id/reject` rejects
property visits. Visit acceptance does not mark a property rented. There is no
new dashboard, offer, notification or webhook in this phase.

Normal request routes check property availability both before and inside the
creation transaction. Request creation, archival and visit decisions share a
listing write lock. Referenced listings are archived with images retained;
unreferenced listings retain their existing deletion behavior. Archived listings
are hidden from catalog/detail/management reads but populate in booking history.
User deletion refuses accounts with customer or hosted-listing booking history.

## Verification and remaining work

Run `npm.cmd test --prefix server` on Windows (or `npm test --prefix server`).
Integration tests mount routers directly, do not import environment/server startup,
and create an isolated temporary local MongoDB replica set with random test
accounts. They never connect to the configured Atlas database. Their temporary
upload fixture is removed during cleanup. Fault-injection mocks exist only in
tests, not production responses.

Phase 2 remains unstarted. Owner/customer workflow screens, rental offers,
notifications and external integrations remain outside these audit repairs.
Manual WhatsApp links, Geoapify, the fixed INR 300 delivery fee, environment files,
and deployment are unchanged. No paid messaging or payment service was enabled.

See [the Phase 1 audit report](./PHASE1-AUDIT-REPORT.md) for issue statuses,
modified files, regression results, preview integrity checks and limitations.
