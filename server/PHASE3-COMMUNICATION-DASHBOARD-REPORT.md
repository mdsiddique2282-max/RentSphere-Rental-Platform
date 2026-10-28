# Phase 3 — Customer–owner communication and dashboard fixes

Date: 2026-10-21. Only the four requested improvements were implemented.

## Completed

### 1. Personal Remove on every request

- Every personal booking/visit card now offers Remove, including Pending, Confirmed, Rejected and Cancelled. The existing cancellation action remains separate.
- Reuses `Booking.hiddenFromCustomer` and `PUT /api/bookings/:id/hide`. Only the creator can hide their record. The endpoint no longer requires cancellation.
- Hiding changes visibility only, never status, price, ownership, dates, listing availability or reserved ranges. Owner/admin history remains visible. The existing custom modal explains this explicitly.
- Hidden state persists in MongoDB across reconnect/login. Missing listing references retain a usable personal history card using request type metadata.
- Existing 3/2/1 history grid, filters and styles are retained.

### 2. Owner Remove for decided requests

- Owner Customer Requests shows a small Remove action only for Confirmed/Accepted, Rejected and Cancelled records. Pending records retain Accept/Reject and cannot be hidden by this operation.
- New `PUT /api/bookings/:id/hide-owner` validates the current authenticated account's approved-owner status and listing ownership on the server. Customers, unrelated owners, pending owners and admins cannot use it as an owner override.
- Uses optional `Booking.hiddenFromOwners`, storing the specific owner's ID. This is separate from customer visibility; it does not globally hide the request from any future/different owner.
- Owner request/visit queries exclude only that owner's hidden cards. Customer and admin queries remain unaffected. No document deletion, cancellation or availability change occurs.
- The existing custom confirmation component is reused with owner-specific explanatory text, keyboard containment, Escape and focus restoration.

### 3. Customer decision notifications

- New compact **Your Request Updates** section is near the top of the customer dashboard. Approved owners see their personal notifications immediately before their personal booking history, separate from their customer-request inbox.
- Notification titles/descriptions distinguish vehicle acceptance/rejection and property visit approval/rejection using actual saved booking status and listing details.
- New decisions write optional `Booking.ownerDecision` metadata (status, decision time and later dismissal time) inside the existing confirmation/rejection transaction. No separate notification collection or duplicate notification documents are created.
- Existing historical confirmed/rejected requests have no marker and are not backfilled or shown as new alerts. Repeated confirmation returns the existing decision without creating/resetting a notification. A new decision on an old pending request is eligible because that decision is new.
- `GET /api/bookings/notifications` returns only the authenticated creator's undismissed new decisions while the current status still matches the decision. Cancellation does not leave an obsolete acceptance alert visible.
- `PUT /api/bookings/:id/dismiss-notification` is creator-only and persists dismissal independently of customer/owner card visibility and status. Removing a card does not dismiss its alert; dismissing an alert does not remove its card.
- Fetches on dashboard mount and manual Refresh; no intervals or polling loops. Responses from an old session cannot replace a newly signed-in customer's notification state.
- Accepted updates offer a user-initiated WhatsApp contact link containing the actual listing name and request/date context. It reuses the fixed recipient utility. Missing/deleted listings and invalid owner contact display a useful message without silently routing to the configured friend number.
- Property approval remains approval of a **visit**, not a property rental. Existing customer Interested/Not Interested API and WhatsApp workflow are unchanged.

### 4. WhatsApp corrections

- Both pickup and delivery messages append the requested **Note for Vehicle Owner**, directing Accept/Reject to the website Owner Dashboard.
- Property visit messages append the requested **Note for Property Owner**, directing visit Accept/Reject to the website and asking the owner to coordinate exact location/time after acceptance. No owner Interested/Not Interested instruction was added.
- Genuine current owner-form uploads are recognized by their existing server-managed `hostingDetailsVersion` marker, unless they have a known predefined/catalog identity. They no longer receive a request-message sample disclaimer even if a stale sample flag is present.
- Existing exact predefined IDs, legacy IDs and catalog keys take precedence. Actual sample/catalog inventory keeps its truthful disclosure and existing configured contact. A genuine owner upload with an invalid phone still errors; it never falls back to the friend number.
- No listing data was modified to correct classification. The new helper affects request-message classification, not stored verification/inventory status.
- Existing customer details, dates, full address, price calculations, applicable ₹300 delivery charge, share-intent routing and save-Pending-before-WhatsApp navigation remain. The customer must still press Send. WhatsApp replies do not change website state.

## Schema and API changes

No migration, backfill, reset, new index or notification collection is needed. New fields have no defaults that populate historical records:

- `Booking.hiddenFromOwners`: optional owner-ID array.
- `Booking.ownerDecision`: optional decision/dismissal metadata.
- Existing `Booking.hiddenFromCustomer`: reused for every personal request status.

New endpoints:

| Endpoint | Access and effect |
| --- | --- |
| `PUT /api/bookings/:id/hide-owner` | Approved listing owner; decided records only; add only their visibility flag |
| `GET /api/bookings/notifications` | Creator-scoped undismissed new decisions |
| `PUT /api/bookings/:id/dismiss-notification` | Creator-only dismissal, without status/history changes |

Existing `PUT /api/bookings/:id/hide` now accepts all request statuses with the same creator-only authorization. Existing Accept/Reject transaction and conflict enforcement remain; decision metadata is committed atomically alongside the successful transition.

## Files modified

Backend:

- `server/models/Booking.js`
- `server/routes/bookings.js`
- `server/utils/vehicleBookings.js`
- `server/utils/propertyVisits.js`

Frontend:

- `src/components/CustomerRequests.jsx`
- `src/components/HistoryConfirmation.jsx`
- `src/components/OwnerRequests.jsx`
- `src/components/RequestNotifications.jsx` — new
- `src/components/RequestNotifications.css` — new, scoped to the added section
- `src/components/UserDashboard.jsx`
- `src/components/BookingModal.jsx` — genuine-upload disclosure guard only
- `src/data/requestNotifications.js` — new notification text/contact helper
- `src/data/whatsappRecipient.js`
- `src/data/requests.js`
- `src/data/vehicleBookingMessage.js`

Tests/report:

- `server/test/ownerHosting.integration.test.js`
- `server/test/phase3-ui.test.js`
- `server/test/vehicleBookingMessage.test.js`
- `server/PHASE3-COMMUNICATION-DASHBOARD-REPORT.md`

Local logs/checks: `tmp/communication-*`. Generated frontend build: `dist/`.

## Test and runtime results

- **Complete backend suite: 169 passed, 0 failed, 0 skipped.** `tmp/communication-backend.log`.
- **Focused integration/UI/message suite: 34 passed, 0 failed.** `tmp/communication-focused.log`; included in the full run.
- **Frontend production build: PASS.** `tmp/communication-build.log`.
- **Git whitespace check: PASS.**
- Tests cover all-status customer hiding, terminal-only owner hiding, authorization/session isolation, no deletion/status/price/date changes, retained confirmed overlap protection, customer/admin visibility, reconnect/login persistence, private notifications for both request types and decisions, independent persisted dismissal, no historical alert backfill, repeated confirmation, missing listing references, WhatsApp routing/classification/owner notes and unchanged interest/pricing/share ordering.
- Old cancelled-only assertions were updated to the newly requested all-status behavior; their creator authorization, error handling and persistence checks remain. Separate tests now exercise every request status.
- Reloaded only the existing staging backend with the approved staging launcher so added routes are live. Checked the three new endpoints directly on port 5000 and through Vite on 5173: each unauthenticated request returned **401 JSON**, proving route/proxy registration without performing an authorized mutation. No password, token or private configuration value was printed.

## Safety and preservation

- All authenticated database mutation tests used disposable local MongoDB replica sets. No production connection, staging document mutation, migration, seed, reset, deletion or bulk modification was performed for this task.
- Runtime checks were rejected by authentication before record access/mutation. Restart used the existing staging-only configuration guard; no environment credentials were changed.
- Original isolated preview snapshot hash is unchanged. All **154 original media files match the approved content digest**; all **six additional uploads** are retained, **160 total**. Original media references validate. No media file was altered or deleted.
- Preservation checks confirm authentication, roles, navbar/footer, admin interface, App/routing/property-interest UI, owner approval, pricing policy, listing-management routes, owner hosting/edit logic and existing history/dashboard CSS remain unchanged outside the requested additions.
- No deployment, payment gateway, Cloudinary, WhatsApp API/webhook, Gmail configuration or new admin management work occurred.

## Remaining manual browser checks

- Verify Remove and Cancel remain distinct for each personal request status, and owner Remove appears only after a decision/cancellation. Check dialog keyboard/focus behavior.
- With normal user-initiated test activity, accept/reject a property visit and a vehicle request, then refresh that customer's request updates. Verify titles, WhatsApp contact destination and independent Dismiss persistence.
- Check the approved owner's personal notifications appear in their personal-history context, not as alerts for unrelated customers.
- Preview pickup/delivery/property WhatsApp messages, including owner instructions, sample distinctions and saved contacts. Sending remains manual.
- Review the compact notification section at desktop/mobile sizes. No interactive browser acceptance is claimed; automated rendering and API checks passed.

Implementation and automated checks are complete. Stop here and await approval before additional work.
