# Authentication and notifications - 20 October 2026

## Root cause

The isolated preview's `ensureHost` in `server/utils/finalCatalogPreview.js`
creates the local `admin@rentsphere.com` account from catalog owner metadata,
preserving the catalog owner's ID but using a generated local password. It does
not import the live Atlas password. The existing account's local bcrypt hash
therefore rejects a different password; registration correctly refuses the same
existing email. This is not a missing-account or public-role-assignment bug.

The old maintenance command generated passwords and printed them. A separate
preview administrator also had a plaintext `admin-login.json` credential sidecar.
Neither is appropriate when the user wants to choose a private password.

Login/registration previously rendered success inside AuthForm and immediately
navigated away, unmounting that message. There was no route-persistent toast layer.

## Changes

- Added `npm.cmd run preview:admin -- --set-password admin@rentsphere.com`.
  It prompts twice with terminal echo disabled, validates the chosen password,
  and stores a bcrypt hash. No password appears in arguments, logs or a new
  plaintext credential file. Legacy `--reset` / `--reset-account` commands now
  also accept chosen passwords instead of generating and printing passwords.
- The offline tool requires exactly one existing account, preserves its ID and
  role, refuses an active preview lock and never loads `.env` or connects to a
  database. It backs up `state.json` before replacing it atomically.
- The password-setting operation also removes an obsolete `admin-login.json`
  file if present. This removes plaintext credentials without changing any other
  account's password. Preview startup no longer reads or writes that sidecar,
  and startup messages no longer print passwords.
- Added a global toast viewport outside the changing page routes. Green success
  and red error notifications expire after 3.5 seconds, support dismissal and
  accessible status/alert semantics, and suppress duplicate active messages.
- AuthForm retains inline feedback and its layout. It disables repeated in-flight
  submissions. Registration validates chosen passwords consistently; login retains
  compatibility with existing shorter passwords. Backend authentication routes,
  password hashing, JWTs and public role restrictions were not changed.

Messages:

| Event | Toast |
| --- | --- |
| Login success | Logged in successfully! |
| Invalid credentials | Invalid email or password. |
| Login server/network failure | Unable to log in. Please try again. |
| Registration success | Account created successfully! |
| Existing email | This email is already registered. |
| Invalid inputs | Clear field-specific validation message, also shown inline |

## Setting the existing admin password - approval pending

**The actual saved preview account has not been changed.** The proposed change
replaces only `password` with a newly computed bcrypt hash for:

- Email: `admin@rentsphere.com`
- Existing ID: `6ad4aa8b98166bf0d4230f0c`
- Role: `admin` (retained)

It creates a backup of the current hash-only state and removes the obsolete
plaintext credential sidecar if present. All other users, listing IDs, bookings,
JWT signing state and media remain unchanged. No live Atlas account is accessed.

After approval, perform the private entry yourself in your IDE terminal:

1. Stop the isolated preview with **Ctrl+C** and wait for shutdown to finish.
2. From `RentSphere-master`, run:

   ```powershell
   npm.cmd run preview:admin -- --set-password admin@rentsphere.com
   ```

3. Enter your chosen password at **New password (hidden)** and enter it again at
   **Confirm password (hidden)**. Characters will not be displayed. Do not put
   the password in the command, a file, an environment variable or this chat.
   Use at least six characters and at most 72 UTF-8 bytes. Blank passwords and
   mismatched confirmation are rejected without changing the account.
4. Restart with `npm.cmd run preview:catalog`. Use the printed local preview URL.
5. Log in with `admin@rentsphere.com` and your chosen password. The existing
   account should open `/admin`. Do not register the admin email again.

The tool does not create accounts or alter public registration to grant admin.

## Tests and preservation

- Complete backend suite: **100 passed, 0 failed, 0 skipped**. Five new notification
  tests were added; existing reset tests were updated to verify chosen-password
  behavior, privacy and preservation rather than relying on printed secrets.
- Production build: **PASS**, Vite, 43 modules.
- Disposable preview tests verify chosen-password registration/login, duplicate
  rejection, no public admin escalation, existing admin ID/role preservation,
  chosen-admin-password login after restart and authorized admin API access.
- Notification regressions verify exact message mapping, no session/navigation
  on failure, inline-compatible validation, duplicate suppression, automatic
  expiry, and real viewport rendering across page changes.
- No new manual browser/UI session was used; admin dashboard authorization was
  checked through its protected APIs and frontend success navigation was tested.
  Actual-account login awaits approval and private password entry.
- At task start the saved preview already contained **48 listings, 14 users and
  16 bookings**, differing from the earlier 47/14/14 report. All current records
  were preserved; nothing was deleted to restore earlier counts.
- The saved-state SHA-256 stayed
  `54a8b4a7eb9d420811251dee30e8397edaff04b07bd610e465d1842ab9a109e9`.
- All **146 catalog/media files** matched before/after. The final full-suite
  integrity check additionally covers both upload directories, **154 files** in
  total. Fingerprints are under `tmp/auth-*-integrity-*.json` and
  `tmp/auth-integrity-*.json`; test/build logs are `tmp/auth-tests.log` and
  `tmp/auth-build.log`.
- No existing saved account/password, role, listing, booking, media file or
  preview database was changed/reset. No Atlas access, deployment, push or
  Phase 2 work occurred. Existing page design, CSS and routes are retained;
  new toast styling is isolated in its own stylesheet.

## Files changed in this task

- `server/scripts/preview-admin.js`
- `server/scripts/preview-quick-catalog.js` (remove password output)
- `server/utils/finalCatalogPreview.js` (stop plaintext credential sidecar I/O)
- `server/utils/previewPassword.js` (new)
- `server/test/previewAdmin.test.js`
- `server/test/previewAuthentication.test.js`
- `server/test/finalPreview.test.js`
- `server/test/helpers/previewPasswordProcess.js` (new)
- `server/test/authNotifications.test.js` (new)
- `src/components/AuthForm.jsx`
- `src/components/ToastViewport.jsx` (new)
- `src/components/ToastViewport.css` (new)
- `src/data/authentication.js` (new)
- `src/data/toasts.js` (new)
- `src/main.jsx`
- This report; task-only inspection scripts/logs/fingerprints under `tmp/`.

The legacy credential sidecar in the actual preview, if present, remains
untouched until the approved password-setting operation. It is no longer read
or printed by the application.
