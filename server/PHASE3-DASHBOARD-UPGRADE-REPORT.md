# Phase 3 — Dashboard separation and booking history

Date: 2026-10-21. Scope: only the two features in the latest attached request.

## Features delivered

### Verified dashboards and navigation

- `/dashboard` is preserved and selects the customer or approved-owner dashboard using a verified backend account response. `/owner-dashboard` is an additional protected owner entry point; unapproved accounts return to their customer dashboard, unauthenticated visitors go to login, and admins retain `/admin`.
- The navbar contains one dashboard link: **User Dashboard**, **Owner Dashboard**, or **Admin Dashboard**. The old **My Listings** and duplicate owner dashboard/application links are removed. Existing navbar styling remains.
- New read-only `GET /api/auth/me` validates the current JWT/session version and retrieves the account from MongoDB. Its response contains identity, role and limited application status/review text; it excludes password hashes, verification documents and ID proof numbers.
- AuthContext refreshes that verified account on session initialization/login and window focus. The existing onboarding page also requests a refresh when its application status changes. Approval therefore works with an existing valid JWT as well as after refresh/login; no manual role edits are needed.
- Cached/localStorage role and approval labels do not grant owner dashboard access. Initial verification displays a loading state; a service failure displays a retry state without granting owner content or discarding an otherwise valid session. Expired/revoked sessions are cleared. Stale account responses cannot replace a newly signed-in account.
- Refreshing an already verified unchanged account preserves its component state, so opening a file picker or returning focus does not unnecessarily discard an in-progress hosting/editing form.

Customer dashboard:

1. Welcome and customer-specific description.
2. Blue owner-promotion banner opening the existing `/become-owner` page, or pending/rejected application status. Pending applications have no duplicate submission CTA. Rejections show the existing review reason and link back to the existing editable reapplication workflow.
3. Personal bookings and visits, without empty hosting, uploaded-product, verified-owner or owner-request sections.

Approved-owner dashboard, in DOM and visual order:

1. Owner welcome, name and existing green verified-owner banner with smooth-scroll/focus CTA.
2. My Uploaded Products, including existing View/Edit, availability, custom delete confirmation, images and calendar controls.
3. Existing Customer Requests with Accept/Reject.
4. Complete Batch 1 hosting form.
5. Personal bookings and visits. Owners remain customers when booking another host's rentals.

The existing owner form and admin review system are reused. Submission now uses a conditional update so duplicate/concurrent pending submissions and resubmission of an already approved application return 409. Rejected applications can still edit and resubmit the same account/application. No existing account or role was changed for this implementation.

### Personal history layout and safe removal

- Both dashboards share the existing history component, now with **three columns above 1050px**, **two columns from 641–1050px**, and **one column at 640px and below**.
- Thumbnails, titles, statuses, dates, amounts, delivery/pickup details, filters, Refresh, View listing and existing permitted cancellation remain.
- Only cancelled cards show a small labelled bin/Remove action. Cancellation and removal remain separate operations.
- A custom in-app dialog uses the requested title, explanation and Cancel/Remove buttons. It supports initial focus, Tab containment, Escape when not saving, focus restoration and an in-dialog error. No native alert/confirm is used.
- New authenticated `PUT /api/bookings/:id/hide` checks the record, creator and cancelled state. Invalid/missing IDs return 404, missing/invalid authentication returns 401, a different account returns 403, a non-cancelled state returns 409, and a database failure returns 503. Repeating a successful hide is safe.
- Optional `Booking.hiddenFromCustomer` has **no default or migration**. Existing records remain visible. The endpoint only sets this field (plus normal update timestamp); it never deletes the request or changes its status, dates, ownership, listing reference or price.
- Only `/api/bookings/mybookings` excludes hidden records. Owner request/visit inboxes, admin booking queries, statistics and availability calculations retain their previous queries/behavior.
- The UI removes a card only after the server confirms the matching ID and hidden state. Errors leave it visible. Hidden state survives reconnect/login. A stale history response cannot reintroduce a just-hidden card.

## Files changed

Frontend:

- `src/App.jsx` — protected owner dashboard entry point; existing routes retained.
- `src/context/AuthContext.jsx` — authoritative account refresh and safe session state.
- `src/data/account.js` — new account refresh/dashboard classification helpers.
- `src/data/requestHistory.js` — confirmed-success history-removal client helper.
- `src/components/Layout.jsx` — one correct dashboard navigation link.
- `src/components/UserDashboard.jsx` — distinct customer/owner views and application banner.
- `src/components/Dashboard.css` — new scoped dashboard/banner/product layout styles.
- `src/components/OwnerOnboarding.jsx` — refresh account status through the existing flow.
- `src/components/CustomerRequests.jsx` — cancelled-card removal and existing personal history.
- `src/components/CustomerRequests.css` — three/two/one-column layout and subtle action.
- `src/components/HistoryConfirmation.jsx` — new accessible custom history confirmation.

Backend:

- `server/routes/auth.js` — read-only verified account endpoint.
- `server/routes/owner.js` — conditional application submission/duplicate guard.
- `server/routes/bookings.js` — creator-only hide endpoint and personal-history filter.
- `server/models/Booking.js` — optional visibility field.

Tests and report:

- `server/test/ownerHosting.integration.test.js` — extended isolated integration tests.
- `server/test/phase3-ui.test.js` — updated and extended actual component rendering/client tests.
- `server/PHASE3-DASHBOARD-UPGRADE-REPORT.md` — this report.

Local edit helpers, the prior owner-component snapshot and verification logs are under `tmp/dashboard-upgrade-*`. Generated frontend output is under `dist/`.

## Validation

- Full backend suite: **150 passed, 0 failed, 0 skipped**. Includes all previous tests and hosting/edit/image, authorization, saved-listing, booking/visit conflict, cancellation, WhatsApp and SMTP mock regressions. Log: `tmp/dashboard-upgrade-backend.log`.
- Focused component/session checks: **10 passed, 0 failed**; also included in the full suite. Log: `tmp/dashboard-upgrade-ui.log`.
- Frontend production build: **PASS**. Log: `tmp/dashboard-upgrade-build.log`.
- Git whitespace check: **PASS**.
- New checks cover normal/pending/rejected/approved/admin dashboard/navigation, owner-first section order, safe loading/error states, existing application links, approval with an old session, safe rejection/reapplication, concurrent submission denial, owner customer bookings, cross-owner denial, both cancelled request types, creator-only visibility, invalid states/IDs, repeated hiding, simulated write failure, persistence after reconnect and actual login, owner/admin visibility, preserved document/listing data and availability, responsive grid rules, accessible dialog content and failed client requests not hiding cards.
- Frontend checks render components and inspect responsive CSS; they are not interactive visual browser acceptance tests.

## Data safety

- All database writes in automated checks used disposable local MongoDB replica sets; SMTP used mocks. No Atlas connection or staging test-record mutation was performed in this task.
- No production connection, staging reset/reseed, deletion of existing records, migration, deployment or push was performed. Root/private environment files, credentials, owner approvals and real account roles were not modified.
- Original isolated preview snapshot hash is unchanged.
- The original **154 media files match the recorded content digest exactly**. Four additional uploads with timestamps preceding this task are also preserved; current total is **158**, not a reset back to 154. All original preview media references validate. The older exact-count checker correctly reports a count difference because it assumes 154 total; the task-specific offline check verifies the unchanged original digest plus the four additions.
- Offline verification: `node tmp/dashboard-upgrade-data-check.mjs`. It performs no database/network operations.
- Batch 1 hosting fields/editing/uploads, listing availability and archival, owner inbox/decisions, saved hearts, admin interface, property interest section, WhatsApp messages and existing vehicle calendar remain. No compact-calendar changes, new admin management modules, payment system, Cloudinary, WhatsApp Cloud API/webhooks or Gmail configuration were added.

## Remaining manual checks

- Restart the existing development process with `npm run dev` to load the changed backend routes before manual checking. This task did not restart servers or submit forms against staging.
- Review customer and owner dashboards at desktop/tablet/mobile widths, including long titles/addresses and three/two/one history columns.
- Verify the existing application page, pending/rejected state, and navbar/dashboard switch after a real admin decision and account refresh.
- Review owner-first section order, complete hosting/edit form, file picker/preview state after window focus, listing controls and verified-banner smooth scroll.
- Check cancelled-card Remove with keyboard Tab/Escape, focus restoration and refresh/login persistence; confirm owner/admin visibility using an authorized test record when appropriate. Do not remove or alter genuine existing records solely for testing.

No requested implementation is knowingly unfinished. Interactive browser acceptance is pending and has not been claimed. Previously deferred real Gmail delivery remains outside this task and unchanged. Stop here and await approval before any further feature batch.
