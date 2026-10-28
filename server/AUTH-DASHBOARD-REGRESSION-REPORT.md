# Authentication/dashboard regression fix — 2026-10-21

## Confirmed root cause

The actual failing request was **GET `/api/auth/me`**. Before the repair, both
`http://localhost:5000/api/auth/me` and the same path through Vite on port 5173
returned **404**, **`text/html; charset=utf-8`**, and an Express HTML error page
beginning `<!DOCTYPE html>` containing `Cannot GET /api/auth/me`.

The frontend URL includes the correct `/api` prefix. `server/routes/auth.js`
registers `GET /me`, `server/server.js` mounts it at `/api/auth`, and Vite correctly
proxies `/api` to port 5000. None of those paths needed changing.

The backend process was started at **09:37:38**, before `auth.js` was updated with
the new route at **09:56:49**. The previous dashboard task had not restarted the
backend. Vite hot-reloaded the frontend, while the plain Node backend continued
serving its older in-memory route table. This was an Express HTML 404, not Vite's
SPA index page.

The frontend unconditionally called `response.json()` on that HTML body. Its
parsing exception became the dashboard error. AuthContext then discarded the
verified account, and the navbar required a ready verified account to choose its
role label. That explains why an admin could initially open the existing admin
page after login, but later see generic **Dashboard** after account refresh failed.
The failure did **not** change the MongoDB admin role or overwrite it with user.

## Fix implemented

- Restarted only the identified RentSphere staging backend, using the existing
  `npm run dev:backend` launcher and unchanged private staging configuration.
  The original frontend remains on port 5173; the corrected backend is running
  on port 5000. The restart was completed outside the network sandbox so the
  staging Atlas connection works normally.
- `fetchCurrentAccount` now requests JSON, checks Content-Type, reads the body
  safely, validates JSON shape and bounds the request to 10 seconds. HTML,
  malformed JSON, network failures and timeouts display **“Account verification
  is temporarily unavailable. Please try again.”** No HTML body or raw parser
  error is shown.
- A genuine JSON 401 still invalidates the session. An HTML/proxy 401 does not
  masquerade as proof that a valid JWT was revoked.
- A transient refresh failure retains only the same session's previously
  backend-verified identity in memory. The navbar can retain its correct
  User/Owner/Admin label. It never obtains approval from localStorage and never
  substitutes a default user role.
- Dashboard access still requires successful account verification. On a genuine
  verification failure the existing error/retry screen remains; Retry performs
  the actual backend check. Successful retry restores the authoritative account.
- Logout/revocation/session changes still clear or isolate verified identity.
  No owner authorization, admin APIs, passwords, roles or approval rules changed.

## Files changed

Application:

- `src/data/account.js` — response validation, bounded fetch and same-session
  verification-failure state helper.
- `src/context/AuthContext.jsx` — retain previously verified identity on transient
  refresh failure while preserving verification/retry and session isolation.
- `src/components/Layout.jsx` — retain navigation from that verified identity.

Tests/report:

- `server/test/accountRegression.test.js` — new HTML/JSON/network/retry/session
  and role-retention regression tests.
- `server/test/phase3-ui.test.js` — verified admin/owner navigation during
  refresh/error, with existing dashboard/permission tests retained.
- `server/test/ownerHosting.integration.test.js` — update the HTTP mock to include
  the real JSON Content-Type and body contract; original assertions retained.
- `server/AUTH-DASHBOARD-REGRESSION-REPORT.md` — this report.

Local read-only diagnostic helper: `tmp/auth-regression-live-readonly.mjs`.
Test/build logs: `tmp/auth-regression-focused.log`,
`tmp/auth-regression-backend.log`, `tmp/auth-regression-build.log`.

No auth route, server mount, Vite proxy, login redirect or dashboard route change
was necessary: inspection and live responses confirmed their configuration.

## Validation results

- **153 backend tests passed, 0 failed, 0 skipped.** This includes actual HTTP
  password-login/session tests using disposable databases, account approval and
  refresh with existing JWTs, normal/approved-owner/admin dashboard and navbar
  rendering, protected owner routes, hosting/editing/images, customer/owner
  bookings, history removal, cancellation, saved listings and prior regressions.
- **Production frontend build passed.**
- Focused parsing/navigation/session checks: **12 passed, 0 failed** (also included
  in the full suite).
- Reproduced the original HTML 404 through both the direct backend and Vite proxy.
- After restart, real staging accounts of all three types returned **200 JSON**
  through **both** paths, with matching account IDs/roles; the owner response
  retained backend-approved status. These were short-lived in-memory session
  probes signed with the configured application key, not password logins. Tokens,
  keys, credentials, passwords and password hashes were not printed or saved.
- Simulated HTML 200/401/404/502, empty/malformed JSON, JSON 401, network failure,
  retry recovery, same-session role preservation and cross-session isolation.
- The real staging password-login/browser navigation scenarios were **not**
  claimed as interactively verified. The Windows Computer Use helper failed twice
  with `native pipe unavailable` (`os error 2`), so browser interaction could not
  be performed. Existing-account passwords were neither requested nor changed.

## Safety and remaining manual checks

- Database activity for runtime verification was read-only and restricted by the
  existing staging configuration guard to `rentsphere_staging`. Automated writes
  used disposable databases. No production access, staging reset/reseed/deletion,
  role changes, migration or deployment occurred.
- Private/root environment files and credentials were unchanged. No uploaded
  media or original preview data was modified by this fix.
- Normal user: sign in, open Dashboard, navigate Home → Dashboard, then refresh.
  Confirm **User Dashboard**, application banner/status and history.
- Approved owner: sign in, navigate and refresh. Confirm **Owner Dashboard**,
  backend-approved status, hosting and owned-product controls.
- Admin: sign in, navigate Home → Admin Dashboard, then refresh. Confirm its
  navbar label remains **Admin Dashboard** and existing admin features remain.
- If a genuine API outage occurs, confirm the clean error and successful Retry
  after recovery. Owner access must never be granted from an edited cached role.

The root runtime route problem is repaired and staging API verification passed.
Interactive browser/password-login acceptance remains manual. No new features
were implemented; stop here.
