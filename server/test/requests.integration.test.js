import { configureDeliveryQuotes, fixtureDeliveryBody, testPickup, testDeliveryCharge } from './helpers/deliveryQuoteFixture.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import User from '../models/User.js';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';
import bookingRoutes from '../routes/bookings.js';
import { generateToken } from '../utils/tokens.js';
import { todayInIndia, assertNotPastDate } from '../utils/requestDates.js';
import { readFile } from 'node:fs/promises';
import listingRoutes from '../routes/listings.js';

// No production server/env imports: every write goes to a fresh disposable DB.
process.env.JWT_SECRET = randomBytes(48).toString('hex');
let mongo, server, origin, customer, other, host;
const contact = { name: 'Test Customer', email: 'customer@example.test', phone: '9999999999' };
before(async () => {
  mongo = await MongoMemoryReplSet.create({
    binary: { downloadDir: path.join(os.tmpdir(), 'rentsphere-test-mongodb') },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(mongo.getUri(), { dbName: `requests_test_${randomUUID().replaceAll('-', '')}` });
  await Promise.all([User.init(), Listing.init(), Booking.init()]);
  [customer, other, host] = await Promise.all(['user', 'user', 'owner'].map(role => User.create({
    name: 'Test account', email: `${randomUUID()}@example.test`, password: 'test-only', role,
    ...(role === 'owner' ? { ownerProfile: { status: 'approved' } } : {}),
  })));
  const app = express(); configureDeliveryQuotes(app);
  app.use(express.json());
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/listings', listingRoutes);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 180000 });

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

const listing = type => Listing.create({ type, name: 'Test listing', location: 'Mumbai', price: 1000, host: host._id, ...(type === 'vehicle' ? { locationCoordinates: testPickup } : {}) });
const bodyFor = item => ({ listingId: String(item._id), startDate: '2090-01-01', endDate: '2090-01-03', contact });
async function request(suffix = '', { user = customer, body, method = 'POST', token } = {}) {
  if (!suffix && method === 'POST' && body) body = await fixtureDeliveryBody(body, value => request('/delivery-quote', { user, token, body: value }));
  const res = await fetch(`${origin}/api/bookings${suffix}`, {
    method, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : user ? { Authorization: `Bearer ${generateToken(user._id)}` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json() };
}

test('vehicle and property visit requests persist as pending with server-generated unique IDs and authenticated identity', async () => {
  const ids = new Set();
  for (const type of ['vehicle', 'property']) {
    const item = await listing(type);
    const result = await request(type === 'property' ? '/visits' : '', { body: {
      ...bodyFor(item), user: String(other._id), status: 'confirmed', requestId: 'forged',
      requestType: 'forged', totalPrice: 1, deliveryCharge: 1,
      fulfilment: 'delivery', deliveryAddress: 'Mumbai delivery address',
    } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const stored = await Booking.findById(result.data._id);
    assert.equal(stored.status, 'pending');
    assert.equal(String(stored.user), String(customer._id));
    assert.equal(String(stored.listing), String(item._id));
    assert.match(stored.requestId, /^[0-9a-f-]{36}$/);
    assert.notEqual(stored.requestId, 'forged');
    assert.equal(result.data.requestId, stored.requestId);
    ids.add(stored.requestId);
    assert.deepEqual(stored.contact.toObject(), contact);
    assert.equal(stored.requestType, type === 'vehicle' ? 'vehicle' : 'property_visit');
    assert.equal(stored.totalPrice, type === 'vehicle' ? 2000 + testDeliveryCharge : 0);
    assert.equal(stored.deliveryCharge, type === 'vehicle' ? testDeliveryCharge : 0);
    if (type === 'property') {
      assert.equal(stored.startDate.getTime(), stored.endDate.getTime());
      assert.equal(stored.fulfilment, 'pickup');
    }
    assert.equal((await Listing.findById(item._id)).status, 'available');
  }
  assert.equal(ids.size, 2);
  const mine = await request('/mybookings', { method: 'GET' });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.every(item => item.user === String(customer._id)));
  assert.ok(mine.data.some(item => item.requestType === 'property_visit'));
});

test('anonymous, invalid, expired and deleted-user sessions cannot save either request type', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const deleted = await User.create({ name: 'Deleted test', email: `${randomUUID()}@example.test`, password: 'test-only' });
  const deletedToken = generateToken(deleted._id);
  await deleted.deleteOne();
  const before = await Booking.countDocuments();
  for (const suffix of ['', '/visits']) {
    for (const token of [null, 'bad-token', jwt.sign({ id: String(customer._id) }, process.env.JWT_SECRET, { expiresIn: -1 }), deletedToken]) {
      const result = await request(suffix, { user: null, token, body: bodyFor(await listing(suffix ? 'property' : 'vehicle')) });
      assert.equal(result.status, 401);
    }
  }
  assert.equal(await Booking.countDocuments(), before);
});

test('past dates, impossible dates, reversed dates, invalid listing IDs and wrong visit types are rejected without saving', async () => {
  const before = await Booking.countDocuments();
  for (const suffix of ['', '/visits']) {
    const body = bodyFor(await listing(suffix ? 'property' : 'vehicle'));
    for (const change of [
      { startDate: '2000-01-01' }, { startDate: '2090-02-30' },
      { startDate: 'bad' }, { listingId: 'V101' }, { startDate: '2090-01-01T00:00:00Z' },
      { contact: { ...contact, phone: '' } },
    ]) {
      assert.equal((await request(suffix, { body: { ...body, ...change } })).status, 400);
    }
    assert.equal((await request(suffix, { body: { ...body, listingId: String(new mongoose.Types.ObjectId()) } })).status, 404);
  }
  assert.equal((await request('', { body: { ...bodyFor(await listing('vehicle')), endDate: '2089-12-31' } })).status, 400);
  assert.equal((await request('/visits', { body: bodyFor(await listing('vehicle')) })).status, 400);
  assert.equal(await Booking.countDocuments(), before);
});

test('today is valid using the India calendar, including the UTC date boundary', async () => {
  const now = new Date('2026-10-20T18:30:00.000Z');
  assert.equal(todayInIndia(now), '2026-10-21');
  assert.throws(() => assertNotPastDate(new Date('2026-10-20T00:00:00Z'), now), { status: 400 });
  assert.doesNotThrow(() => assertNotPastDate(new Date('2026-10-21T00:00:00Z'), now));
  const day = todayInIndia();
  for (const suffix of ['', '/visits']) {
    const body = { ...bodyFor(await listing(suffix ? 'property' : 'vehicle')), startDate: day, endDate: day };
    assert.equal((await request(suffix, { body })).status, 201);
  }
});

test('concurrent retries create exactly one request; altered delivery details cannot bypass duplicate protection', async () => {
  for (const suffix of ['', '/visits']) {
    const item = await listing(suffix ? 'property' : 'vehicle');
    const body = bodyFor(item);
    const results = await Promise.all(Array.from({ length: 6 }, () => request(suffix, { body })));
    assert.equal(results.filter(r => r.status === 201).length, 1);
    assert.equal(results.filter(r => r.status === 409).length, 5);
    assert.equal(await Booking.countDocuments({ listing: item._id }), 1);
    assert.equal((await request(suffix, { body: { ...body, fulfilment: 'delivery', deliveryAddress: 'Different address' } })).status, 409);
    // The same dates for another user and another date for the same user are valid.
    assert.equal((await request(suffix, { user: other, body })).status, 201);
    assert.equal((await request(suffix, { body: { ...body, startDate: '2090-01-02' } })).status, 201);
  }
});

test('terminal requests release duplicate protection; confirmed requests remain protected', async () => {
  for (const suffix of ['', '/visits']) {
    const item = await listing(suffix ? 'property' : 'vehicle');
    const body = bodyFor(item);
    for (const status of ['cancelled', 'rejected']) {
      const created = await request(suffix, { body });
      assert.equal(created.status, 201);
      await Booking.updateOne({ _id: created.data._id }, { $set: { status } });
    }
    const active = await request(suffix, { body });
    assert.equal(active.status, 201);
    await Booking.updateOne({ _id: active.data._id }, { $set: { status: 'confirmed' } });
    assert.equal((await request(suffix, { body })).status, 409);
  }
});

test('legacy pending vehicle bookings block retries without migrating or rewriting the record', async () => {
  const item = await listing('vehicle');
  const legacy = await Booking.collection.insertOne({
    user: customer._id, listing: item._id, startDate: new Date('2090-01-01T00:00:00Z'),
    endDate: new Date('2090-01-03T00:00:00Z'), status: 'pending', totalPrice: 2000,
  });
  assert.equal((await request('', { body: bodyFor(item) })).status, 409);
  const stored = await Booking.collection.findOne({ _id: legacy.insertedId });
  assert.equal(stored.requestId, undefined);
  assert.equal(stored.submissionKey, undefined);
  assert.equal(await Booking.countDocuments({ listing: item._id }), 1);
});

test('database save failures do not return success or leave records behind', async t => {
  for (const suffix of ['', '/visits']) {
    const item = await listing(suffix ? 'property' : 'vehicle');
    t.mock.method(Booking.prototype, 'save', async () => { throw new Error('Simulated write failure'); });
    try { assert.equal((await request(suffix, { body: bodyFor(item) })).status, 500); }
    finally { t.mock.restoreAll(); }
    assert.equal(await Booking.countDocuments({ listing: item._id }), 0);
  }
});

test('all 74 staged catalog rows stay private; each can use its request API after isolated-test publication', async () => {
  const catalog = JSON.parse(await readFile(new URL('../catalog/mumbai-2026.json', import.meta.url), 'utf8'));
  // These are workflow fixtures in this suite's disposable database only.
  // They do not certify the real manifest's missing photography or ownership.
  const records = await Listing.insertMany(catalog.records.map(row => ({ ...row.listing, host: host._id })));
  const ids = records.map(row => row._id);
  for (const row of records) {
    const detail = await fetch(`${origin}/api/listings/${row._id}`);
    assert.equal(detail.status, 404);
    const result = await request(row.type === 'property' ? '/visits' : '', { body: bodyFor(row) });
    assert.equal(result.status, 404);
  }
  for (const type of ['property', 'vehicle']) {
    const response = await fetch(`${origin}/api/listings?type=${type}`);
    const visible = await response.json();
    assert.ok(visible.every(item => !ids.some(id => String(id) === item._id)));
  }
  // A future, separately approved publication process is simulated ONLY here.
  await Listing.updateMany({ _id: { $in: ids } }, { $set: { publicationState: 'published' } });
  const requestIds = new Set();
  for (const row of records) {
    const result = await request(row.type === 'property' ? '/visits' : '', { body: {
      ...bodyFor(row), fulfilment: 'pickup',
    } });
    assert.equal(result.status, 201, `${row.catalogKey}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.status, 'pending');
    assert.equal(result.data.deliveryCharge, 0);
    assert.equal(result.data.totalPrice, row.type === 'property' ? 0 : row.price * 2);
    requestIds.add(result.data.requestId);
  }
  assert.equal(requestIds.size, 74);
  assert.equal(await Booking.countDocuments({ listing: { $in: ids } }), 74);
});
