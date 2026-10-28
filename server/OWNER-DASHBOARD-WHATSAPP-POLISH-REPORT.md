# Owner Dashboard UI polish and WhatsApp messages

Date: 2026-10-21. Scope: only the three requested improvements.

## WhatsApp changes

### Property visits

- The existing message builder now uses the requested Property Visit Request format, actual title/location/customer values and **Preferred Visit Date**.
- The customer asks for the exact property location, preferably a Google Maps link, and a suitable visiting time.
- It contains no owner Interested/Not Interested instructions, automatic-rental instruction or internal request ID. Sample inventory retains its short `(Demo)` indication.
- The property modal uses the same builder for all property visit requests. Its success heading says **Visit request saved**, with the existing explanation that the customer must send the WhatsApp message.
- Visit APIs, Pending persistence, website Accept/Reject, customer interest decisions and property availability/rental rules are unchanged.

### Vehicle bookings

- Both cars and bikes use **RentSphere — Vehicle Booking Request**, actual vehicle/customer values and the selected date range.
- **Self Pickup** shows Booking Amount and asks for the exact pickup location/Google Maps link, pickup time and required documents.
- **Home Delivery** includes the full entered delivery address, separate Rental Amount and Delivery Charge, Total Amount, and asks for expected delivery time.
- Amounts use the caller's existing calculated total and delivery charge; the displayed rental amount is total minus that charge. Daily pricing, rental-day calculation, the existing applicable ₹300 charge, date validation and overlap/status logic were not changed.
- Sample inventory retains the existing short unverified/demonstration disclosure. Genuine inventory gets no sample disclosure. Internal request IDs and the old long demo banner remain absent.

### Recipient routing and manual sending

Inspection found both share links hardcoded the configured contact for every listing. To meet the requested distinction, a shared recipient helper now:

- Keeps **919403570134**, the existing configured contact, for static/imported/predefined listings, including edited predefined listings and sample catalog inventory.
- Uses the saved listing contact for owner uploads, normalizing valid Indian numbers to WhatsApp's country-code format.
- Reports an invalid/missing owner contact **before request creation**, rather than silently routing an owner upload to someone else. New Batch 1 listings already require a valid phone; an incomplete older owner listing may need its owner to save a valid contact through the existing editor. No existing record was repaired or changed automatically.

The existing share-intent flow remains: reserve a blank tab during the gesture, validate/save the Pending request, then navigate/open WhatsApp with the encoded message. The customer must manually press Send. No Cloud API, webhook, automatic sending or WhatsApp-side status management was added.

## Owner Dashboard polish

- Owner-only root class and stylesheet improve header hierarchy, compact spacing, section headings, borders and shadows, using existing fonts/colors. The green verification notice and smooth-scroll hosting CTA remain.
- Uploaded products use presentation-only cards with a 180px cropped image, category, full wrapping title/location, price/period and real Available/Unavailable badge. The existing image component provides a neutral fallback where needed.
- View Listing, Edit listing, calendar, availability and Delete remain wired to their existing handlers/components. The existing custom deletion modal and safe archival backend are unchanged.
- Customer Requests use compact two-column cards, one column at 720px and below, with name/contact, visit/rental dates, applicable amount/delivery details and status. Pending-only Accept/Reject, filters, Refresh and backend mutation functions are preserved.
- Hosting gains a details subheading, scoped input/focus styling, two-column field spacing, amenity/feature chips, a styled upload area and clear Publish button. Field controls, checkbox values, submission, validation, image selection/removal and upload limits remain intact.
- **User Dashboard and My Bookings & Visits are unchanged**, including personal history's 3/2/1 columns, filters, cancellation, cancelled-history removal and custom confirmation. No navbar/footer/admin/auth/routing redesign occurred.

## Files modified

Application:

- `src/data/requests.js` — property visit message text only; request/date/share transport functions retained.
- `src/data/vehicleBookingMessage.js` — distinct pickup/delivery message templates.
- `src/data/whatsappRecipient.js` — shared predefined/owner recipient selection.
- `src/components/PropertyVisitModal.jsx` — message/recipient integration and saved-request wording.
- `src/components/BookingModal.jsx` — vehicle recipient integration; persistence/calculations retained.
- `src/components/UserDashboard.jsx` — owner-only presentation/component wiring.
- `src/components/OwnerProductCard.jsx` — new presentation-only product card using existing controls.
- `src/components/OwnerRequests.jsx` — compact presentation-only request card/grid; original fetching/decision handlers retained.
- `src/components/OwnerDashboard.css` — new owner-scoped stylesheet.
- `src/components/HostingForm.jsx` — headings/classes/upload presentation only; submit implementation retained exactly.

Tests/report:

- `server/test/vehicleBookingMessage.test.js` — updated expected formats plus property, routing, amount/address and save-before-share checks.
- `server/test/phase3-ui.test.js` — product/request rendering, actions and scoped responsiveness.
- `server/OWNER-DASHBOARD-WHATSAPP-POLISH-REPORT.md` — this report.

Local verification snapshots/helpers and logs are under `tmp/owner-polish-*` and `tmp/check-owner-polish-preservation.mjs`. Production build output is generated in `dist/`.

## Verification results

- **Full backend suite: 159 passed, 0 failed, 0 skipped.** Log: `tmp/owner-polish-backend.log`.
- **Focused UI/message/client checks: 23 passed, 0 failed.** Repeated after the final image-component refinement. Log: `tmp/owner-polish-focused.log`.
- **Frontend production build: PASS.** Log: `tmp/owner-polish-build.log`.
- **Git whitespace check: PASS.**
- Covered property location/time wording and real values, no owner interest instructions, both vehicle fulfilment methods for cars/bikes, full multiline addresses, actual amounts including zero, short sample disclosure, predefined/owner routing, Pending-save/share order, manual sending, owner action visibility, request contact/details, pending-only decisions, form rendering and scoped responsive grid rules. Existing backend tests cover actual owner management, uploads/editing, safe archival, Accept/Reject and conflicts using disposable databases.
- Preservation hashes confirm all backend routes/models/utilities, authentication context/helpers, navbar/footer, admin interface, App/routing, User Dashboard/application-banner implementation and personal-history components/CSS/modal are unchanged. Hosting submit implementation and validation mappings are unchanged.

## Data safety

- No Atlas connection, data write, existing-record edit, migration, reset/reseed, production access, deployment or push was performed for this task. Automated database tests use disposable local instances; no real requests or WhatsApp messages were submitted.
- Original isolated preview snapshot hash is unchanged. All **154 original media files match the recorded content digest**; the four previously noted uploads are retained.
- One additional 80,086-byte upload dated 10:30 was found and preserved as well. Current total is **159 files**: original 154 plus five additional uploads. It was not deleted to force the older 158-file count. All original preview media references validate.
- Offline checks: `node tmp/check-owner-polish-preservation.mjs` and `node tmp/owner-polish-data-check.mjs`.
- Environment files, credentials, roles, approvals, saved listing data and booking/visit records were not changed. No SMTP, payments, Cloudinary, new admin management modules or compact calendar work was added.

## Remaining browser checks

Interactive visual/browser acceptance was not performed and is not claimed. Manually review:

1. Owner header/CTA, product image cropping, wrapped titles and aligned actions on desktop/tablet/mobile.
2. Customer Requests two/one-column layout, long contacts/addresses, and existing status/filter behavior.
3. Property/vehicle hosting fields, checkbox chips, image selection/previews/removal and edit modal/calendar sizing.
4. A WhatsApp preview for predefined and owner-uploaded inventory, checking destination and pickup/delivery/property wording. The customer must choose Send; avoid submitting genuine extra requests merely for a visual check.
5. User Dashboard and personal booking-history appearance remain as before.

No requested implementation is knowingly unfinished. Browser visual/share-app acceptance remains manual. Stop after these three improvements and await approval for any additional work.
