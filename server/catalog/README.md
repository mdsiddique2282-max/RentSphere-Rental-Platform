# Mumbai catalog staging — not a live import

**Urgent 15+15 subset:** see [QUICKSTART.md](QUICKSTART.md). The later task
explicitly permits labelled temporary placeholders. That subset uses its own
explicit approval policy; the full 74-record photographic gates below are
unchanged. No live import has been executed.

This directory prepares the previously planned 36 property and 38 vehicle
samples. Prices, localities, specifications and descriptions come from the
existing Mumbai reports, without repeating pricing research.

## Current state

- 74 MongoDB-compatible draft definitions, with deterministic IDs.
- Every owner assignment and final specification review is pending.
- P01–P36: no coherent, permissioned four/five-room property sets acquired.
- M06: three distinct, decoded, visually checked Tata Tiago reference-model
  photographs, by El monty, CC BY-SA 4.0. See `source-assets/M06/ATTRIBUTION.md`.
  They depict the same blue Geneva 2016 show car, not a Mumbai rental unit.
  Exact powertrain/trim and sample details still require approval.
- Other vehicle keys: discovery candidates only, not accepted galleries.
- No record is ready for import. Missing imagery is never replaced by unrelated
  images, repeated covers, stock interiors from different properties, or AI art.

## Files

- `mumbai-2026.json`: staged listing data, media provenance, approval states.
- `owner-approvals.example.json`: explicitly unapproved assignment template.
- `media-candidates.json`: public source metadata; candidates are not validated
  merely because a search found them. Exact-model matches and content review
  remain necessary. Zero results for a query does not prove no photos exist.
- `media-binary-audit.json`: measured/decode evidence for downloaded candidates.
- `source-assets/`: original source photos with attribution and checksums.

## Safe offline check

From `server/`:

```text
node scripts/import-mumbai-catalog.js
```

This is entirely offline. It does not load `.env`, construct a database client,
import production models or contact MongoDB. It lists count, digest and blockers.
No apply command was run in this task.

`--check-images` additionally checks the actual catalog photo URLs using the
development dependency `sharp`. It measures dimensions, decodes real content,
and compares SHA-256 and perceptual fingerprints. It does not automatically
certify room/model identity, sharpness, copyright or endorsement rights.
The optional `--decoder-module` selects an existing image decoder package path.

## Approval and import safeguards

The CLI defaults to dry run. Applying requires an approval file for the exact
canonical manifest SHA-256, exact database name and every owner assignment,
plus reviewed sample disclosure/attribution presentation. The operator must
explicitly name a URI environment variable and database. The URI's database
must exactly match the approved name. There is no implicit `.env` loading,
default MongoDB address or fallback target.

Before connecting, the importer requires approved details/physical identity,
complete galleries, documented licensing, useful unique angles, current URL and
decode checks, adequate dimensions, and exact/near-duplicate review. Each owner
must still be an admin or an approved owner in that database when applied.
It rechecks actual binary content against the approved image hashes.

Only `insertOne` writes are used. The same fixed IDs are recognized on rerun;
matching documents are skipped. Collisions or changed imported content abort
rather than overwrite. A transaction makes partial inserts invisible on failure.
Two concurrent runs converge on the same fixed IDs. Existing documents and
booking references are hashed and checked inside the transaction. No old
listing, user or booking record is updated/deleted; no indexes are dropped or
created by this importer. The existing destructive `seed.js` is never used.

The import creates **drafts**, not public listings. Drafts are excluded from
public catalog/detail reads and cannot receive requests until separately
approved for publication. Existing records without `publicationState` retain
their existing behavior. No automatic publication/deployment is implemented.
The final public catalog, alias resolution, owner-first ranking and visible
photo-license credits need a separate reviewed publication step once media and
assignments are complete; this preparation does not silently remove today's
demo cards or change the UI.

## Tests

From `server/`, run `npm test` after root development dependencies are installed.
Tests start disposable local MongoDB replica sets. They do not import the
production server/environment loader or use the configured live database.
Synthetic approval/photo metadata exists only inside importer test fixtures;
it is never used to mark real catalog media ready. Image decoder tests use a
real CC-licensed source photograph, with all network responses mocked.

Coverage includes all 74 row schemas, all 74 request workflows after simulated
publication, hidden/unbookable drafts, atomic failure, concurrent/rerun imports,
identity collisions, preserved legacy records/booking references, owner roles,
missing/stale/wrong/duplicate/low-resolution media and changed binary content.

No live import should be approved while the offline check reports blockers.
