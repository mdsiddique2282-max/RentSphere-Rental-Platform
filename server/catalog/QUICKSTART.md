# 15 properties + 15 vehicles — Demo/Sample catalog

Run from the project root:

```text
npm run preview:catalog
```

Open the local URL printed by the command. This launcher creates a new disposable
MongoDB process and shows the existing website backed by the 30 selected records.
It cannot connect to an externally supplied database URI. Stop it with Ctrl+C.

Demo sign-in: `demo@rentsphere.test` / `RentSphereDemo2026!`.
These are credentials for a disposable demo account, not a live account.

- `mumbai-15x15.json` selects existing staging rows, keeping their IDs and rates.
- All 15 property galleries have three unique, labelled text placeholders.
- Fourteen vehicle galleries have two unique, labelled text placeholders.
- M06 has three correctly matched Tata Tiago reference-model photographs and
  visible El monty / CC BY-SA 4.0 credits. They are not a Mumbai fleet claim.
- Missing photographs are never represented as real photographs.
- Login, pending bookings/visits, unique request IDs, duplicate checks and the
  INR 300 delivery charge operate against the disposable database.

The original full 74-record photographic import policy remains intact. The
urgent subset has a separate, explicit temporary-sample approval policy, as
authorized in the task. It does not mark placeholder panels as verified photos.
Any supplied real photos must still pass the original rights/match/quality gates.

No live import was run. To import the 30 samples later, a human must approve the
exact manifest checksum, actual target DB, all owner assignments, sample details,
temporary placeholders and presentation. Publishing also requires explicit
`publishSamples` approval. `owner-approvals-15x15.example.json` is deliberately
unapproved. It cannot be used to apply the import as supplied.

An approved import is insert-only and transactional, refuses ID/content conflicts,
and preserves existing records and bookings. Placeholder/photograph files are in
the normal public asset tree, so the same gallery paths work in the built website.
Existing MongoDB URLs and current records stay untouched. Once DB samples are
present, frontend-only demo cards stop being appended to that catalog.
