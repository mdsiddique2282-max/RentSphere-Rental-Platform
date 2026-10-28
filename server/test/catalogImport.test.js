import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Listing from '../models/Listing.js';
import { validateCatalog, readiness, requireApproval, importCatalog, digest } from '../utils/catalogImport.js';
import { main } from '../scripts/import-mumbai-catalog.js';

// Synthetic media metadata is ONLY an isolated importer test fixture, never
// attached to the actual catalog and never fetched/published as real photos.
const manifest = JSON.parse(await readFile(new URL('../catalog/mumbai-2026.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-20T10:00:00Z');
const hostId = new mongoose.mongo.ObjectId('6ad4aa8b98166bf0d4230f0c');
let mongo, client;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: path.join(os.tmpdir(), 'rentsphere-test-mongodb') },
    replSet: { count: 1, storageEngine: 'wiredTiger' } });
  client = new mongoose.mongo.MongoClient(mongo.getUri());
  await client.connect();
}, { timeout: 180000 });
after(async () => { await client?.close(); await mongo?.stop(); });

function fixture() {
  const catalog = structuredClone(manifest);
  for (const record of catalog.records) {
    record.approval = { owner: 'approved', details: 'approved', media: 'approved' };
    record.specificationReview.status = 'approved';
    const count = record.listing.type === 'property' ? 4 : 3;
    record.media = Array.from({ length: count }, (_, i) => {
      const hash = createHash('sha256').update(`${record.key}/synthetic-test-only/${i}`).digest('hex');
      return { url: `https://test-only.example.invalid/${record.key}/${i}.jpg`,
        sourcePage: `https://test-only.example.invalid/source/${record.key}/${i}`,
        license: 'Written permission', licenseUrl: 'https://test-only.example.invalid/test-license',
        author: 'Synthetic test fixture', attribution: 'TEST ONLY — NOT A REAL PHOTO',
        licenseEvidence: 'Test fixture only', rightsReviewedBy: 'test', rightsApproved: true,
        kind: 'photograph', matchApproved: true, matchReviewedBy: 'test', identityEvidence: 'Test only',
        depictedCatalogKey: record.listing.catalogKey, setId: `test-only-${record.key}`, angle: `view-${i}`,
        qualityApproved: true, qualityReviewedBy: 'test', width: 2400, height: 1600,
        httpStatus: 200, checkedAt: now.toISOString(), decoded: true, sha256: hash, dHash: hash.slice(0, 16) };
    });
  }
  return catalog;
}
function approvalFor(catalog, targetDatabase) {
  return { approved: true, presentationReviewed: true, manifestSha256: digest(catalog), targetDatabase,
    assignments: Object.fromEntries(catalog.records.map(row => [row.key, { host: row.listing.host, approved: true }])) };
}
async function database(role = 'admin') {
  const name = `catalog_test_${randomUUID().replaceAll('-', '')}`;
  const db = client.db(name);
  await db.collection('users').insertOne({ _id: hostId, name: 'Test custodian only', role,
    ...(role === 'owner' ? { ownerProfile: { status: 'pending' } } : {}) });
  const existing = Array.from({ length: 8 }, (_, index) => ({ _id: new mongoose.mongo.ObjectId(),
    type: index < 4 ? 'property' : 'vehicle', host: hostId,
    name: index < 4 ? 'Duplicate-looking property' : 'Duplicate-looking vehicle',
    location: index < 6 ? 'Mumbai, Maharashtra' : 'Chennai, Tamil Nadu',
    status: index === 1 ? 'rented' : 'available', price: 1000 + index,
    createdAt: new Date('2020-01-01T00:00:00Z') }));
  await db.collection('listings').insertMany(existing);
  await db.collection('bookings').insertOne({ listing: existing[0]._id, user: hostId, status: 'pending', requestId: 'preserve-test-reference' });
  return { name, db, existing };
}
const verifyFixtureOnly = async () => {}; // Never used by the production CLI.

test('all planned rows are MongoDB-compatible, with original planned rates and sample metadata', async () => {
  assert.deepEqual(validateCatalog(manifest), { properties: 36, vehicles: 38, total: 74, manifestSha256: digest(manifest) });
  for (const record of manifest.records) {
    const document = new Listing(record.listing);
    await document.validate();
    assert.equal(document.catalogKey, record.listing.catalogKey);
    assert.equal(document.inventoryKind, 'sample');
    assert.equal(document.price, record.listing.price);
  }
  assert.equal(manifest.records.find(row => row.key === 'P01').listing.price, 24000);
  assert.equal(manifest.records.find(row => row.key === 'P34').listing.price, 300000);
  assert.equal(manifest.records.find(row => row.key === 'M22').listing.price, 6500);
  assert.equal(readiness(manifest).filter(row => row.ready).length, 0);
});

test('actual incomplete manifest cannot contact a database even with an approval-shaped object', async () => {
  let touched = false;
  const fakeClient = { db: () => { touched = true; throw Error('Must not contact DB'); } };
  await assert.rejects(importCatalog({ client: fakeClient, catalog: manifest, approval: approvalFor(manifest, 'test'),
    targetDatabase: 'test', now, verifyPhotos: verifyFixtureOnly }), /blocked/);
  assert.equal(touched, false);
});

test('offline CLI has no database dependency and apply refuses an unapproved receipt before URI access', async t => {
  const log = t.mock.method(console, 'log', () => {});
  await main([]);
  assert.equal(JSON.parse(log.mock.calls[0].arguments[0]).mode, 'offline-dry-run');
  await assert.rejects(main(['--apply', '--approval', new URL('../catalog/owner-approvals.example.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    '--target-db', 'never_connect', '--uri-env', 'RENTSHPERE_DOES_NOT_EXIST']), /Explicit approval/);
});

test('manifest shape rejects duplicate IDs, wrong geography, invalid prices and injected operators', () => {
  for (const mutate of [
    data => { data.records[1].key = data.records[0].key; },
    data => { data.records[0].listing._id = data.records[1].listing._id; },
    data => { data.records[0].listing.location = 'Vashi, Navi Mumbai, Maharashtra'; },
    data => { data.records[0].listing.price = -1; },
    data => { data.records[0].listing.$set = { host: 'forged' }; },
    data => { data.records[0].listing.inventoryKind = 'verified'; },
  ]) {
    const data = structuredClone(manifest); mutate(data);
    assert.throws(() => validateCatalog(data));
  }
});

test('media gate rejects missing rights, mixed rooms, duplicates, wrong models, low quality and stale URLs', () => {
  assert.ok(readiness(fixture(), now).every(row => row.ready));
  for (const mutate of [
    data => { data.records[0].media[0].license = 'Editorial only'; },
    data => { data.records[0].media[0].setId = 'different-property'; },
    data => { data.records[0].media[0].sha256 = data.records[1].media[0].sha256; },
    data => { data.records[0].media[0].depictedCatalogKey = 'wrong-model'; },
    data => { data.records[0].media[0].width = 800; },
    data => { data.records[0].media[0].httpStatus = 404; },
    data => { data.records[0].media[0].checkedAt = '2020-01-01'; },
    data => { data.records[0].media[0].rightsApproved = false; },
    data => { data.records[0].media[0].dHash = data.records[1].media[0].dHash; },
  ]) { const data = fixture(); mutate(data); assert.ok(readiness(data, now).some(row => !row.ready)); }
});

test('approval pins manifest, database, presentation and each owner assignment', () => {
  const catalog = fixture();
  for (const mutate of [
    value => { value.manifestSha256 = 'wrong'; }, value => { value.targetDatabase = 'other'; },
    value => { value.approved = false; }, value => { value.presentationReviewed = false; },
    value => { value.assignments.P01.host = 'different'; },
  ]) { const approval = approvalFor(catalog, 'test'); mutate(approval); assert.throws(() => requireApproval(catalog, approval, 'test', now)); }
});

test('insert-only import and rerun preserve every legacy record, owner, rented status and booking reference', async () => {
  const { name, db, existing } = await database();
  const before = await db.collection('listings').find({}).toArray();
  const bookings = await db.collection('bookings').find({}).toArray();
  const catalog = fixture(); const approval = approvalFor(catalog, name);
  const options = { client, catalog, approval, targetDatabase: name, verifyPhotos: verifyFixtureOnly, now };
  assert.equal((await importCatalog(options)).inserted, 74);
  assert.equal((await importCatalog(options)).skipped, 74);
  assert.equal(await db.collection('listings').countDocuments(), 82);
  assert.deepEqual(await db.collection('listings').find({ _id: { $in: existing.map(row => row._id) } }).toArray(), before);
  assert.deepEqual(await db.collection('bookings').find({}).toArray(), bookings);
  assert.equal(await db.collection('listings').countDocuments({ inventoryKind: 'sample', publicationState: 'draft' }), 74);
});

test('identity collisions abort all inserts without overwriting unrelated records', async () => {
  const { name, db } = await database(); const catalog = fixture();
  const collision = { _id: new mongoose.mongo.ObjectId(catalog.records[20].listing._id), name: 'Unrelated existing asset' };
  await db.collection('listings').insertOne(collision);
  await assert.rejects(importCatalog({ client, catalog, approval: approvalFor(catalog, name), targetDatabase: name, verifyPhotos: verifyFixtureOnly, now }), /collision/);
  assert.equal(await db.collection('listings').countDocuments(), 9);
  assert.deepEqual(await db.collection('listings').findOne({ _id: collision._id }), collision);
});

test('changed imported data is never overwritten and unapproved owners cannot receive samples', async () => {
  const { name, db } = await database(); const catalog = fixture();
  const options = { client, catalog, approval: approvalFor(catalog, name), targetDatabase: name, verifyPhotos: verifyFixtureOnly, now };
  await importCatalog(options);
  const id = new mongoose.mongo.ObjectId(catalog.records[0].listing._id);
  await db.collection('listings').updateOne({ _id: id }, { $set: { price: 999 } }); // Test DB only.
  await assert.rejects(importCatalog(options), /differs/);
  assert.equal((await db.collection('listings').findOne({ _id: id })).price, 999);
  for (const role of ['user', 'owner']) {
    const target = await database(role);
    await assert.rejects(importCatalog({ ...options, targetDatabase: target.name, approval: approvalFor(catalog, target.name) }), /publishing approval/);
    assert.equal(await target.db.collection('listings').countDocuments(), 8);
  }
});

test('simultaneous imports converge on one copy of each fixed ID', async () => {
  const { name, db } = await database(); const catalog = fixture();
  const options = { client, catalog, approval: approvalFor(catalog, name), targetDatabase: name, verifyPhotos: verifyFixtureOnly, now };
  const results = await Promise.all([importCatalog(options), importCatalog(options)]);
  assert.equal(results.reduce((sum, row) => sum + row.inserted, 0), 74);
  assert.equal(await db.collection('listings').countDocuments(), 82);
});
