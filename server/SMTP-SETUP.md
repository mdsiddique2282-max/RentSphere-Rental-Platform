# Gmail SMTP setup — pending sender configuration

No real email has been sent. The sender is not finalized. SMTP has been tested
using an injected mock transport; missing private configuration returns an
honest 503 response rather than pretending to send mail.

When you select the Gmail sender:

1. Enable Google Account 2-Step Verification for that account.
2. Create an App Password for RentSphere staging. Use an App Password, **not**
   your normal Google password. Follow Google's [App Password instructions](https://support.google.com/accounts/answer/185833).
   Google documents that organizational restrictions or Advanced Protection may
   prevent this option from being available.
3. Add only the following new fields to private `server/.env.staging.local`.
   Leave the existing Atlas URI, JWT secret and backup key unchanged. Fill the
   blank values privately; never paste the App Password into chat or logs.

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=
APP_BASE_URL=http://localhost:5173
```

Use your selected sender address for SMTP_USER and EMAIL_FROM. SMTP_PASS is the
App Password. SMTP requires TLS; port 465 uses immediate TLS, or port 587 can use
required STARTTLS. Configuration follows the [Nodemailer SMTP options](https://nodemailer.com/smtp).

4. Stop current development servers cleanly and restart once using `npm run dev`.
   The staging launcher reads these fields without loading production settings.
5. Before any real email test, confirm the sender address and authorize that
   test. Use an account you explicitly choose for the test. No automatic SMTP
   verification or test message runs on server startup.

Reset links expire after 15 minutes. Only their SHA-256 hashes are stored. A
successful reset consumes the token, hashes the chosen password with bcrypt and
invalidates older JWT sessions. Request throttles persist in MongoDB and do not
reveal whether an email has an account. Email delivery is queued independently
of the public HTTP response; failures log only a generic operational message,
invalidate that unusable token and do not change the existing password.

Private settings must remain untracked and excluded from backups. Do not run
real email tests until sender setup and the user's separate approval are ready.
