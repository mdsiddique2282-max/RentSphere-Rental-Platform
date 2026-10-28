# Phase 3 audit and implementation plan

Audit completed before implementation. Reuse existing React/CSS, protected
listing routes, custom deletion modal, owner onboarding/admin review, shared
transition policy, MongoDB transactions, date validation, JWT/bcrypt, and
WhatsApp message builders. No migration, staging fixtures or existing account
updates are needed to implement these modules. Tests use disposable databases.

1. Add authenticated MongoDB save/unsave APIs and connect existing heart controls;
   add customer booking/visit history, status grouping and cancellation using
   existing request endpoints. Keep anonymous favourites as a local convenience.
2. Extend the existing dashboard for approved-owner editing, availability,
   scoped request inbox/decisions, and vehicle calendars. Add admin availability
   controls without listing-detail editing. Preserve historical references and
   existing confirmation modals. Add a backward-compatible manual availability
   flag rather than conflating date bookings with a rented listing.
3. Make staging customer property-interest recording independent of rental
   availability, retaining the original isolated-preview behavior unchanged.
4. Add secure password reset with expiring one-time hashed tokens, enumeration
   protection and request throttling, after email-provider decision. No secrets
   in code/logs/responses. Configure via private staging environment.
5. Run integration/security tests after each step, full regression suite and
   production build. Document endpoints, permissions, configuration, remaining
   manual checks and external setup requirements. Never deploy or access production.

Clarifications resolved: user confirmed the scope above and chose Gmail SMTP
with Nodemailer and mock-transport tests. Sender is intentionally undecided;
real email delivery must remain pending configuration and no real email is to
be sent. No existing role or ownership changes are planned; historical user-role
listing hosts must use existing admin-reviewed onboarding before acquiring
management permissions. See PHASE3-IMPLEMENTATION-REPORT.md for final validation.
