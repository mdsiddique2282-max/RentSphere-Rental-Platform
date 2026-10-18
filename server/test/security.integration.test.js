import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import User from '../models/User.js';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';
import OwnerDocument from '../models/OwnerDocument.js';
import authRoutes from '../routes/auth.js';
import bookingRoutes from '../routes/bookings.js';
import ownerRoutes from '../routes/owner.js';
import adminRoutes from '../routes/admin.js';
import { generateToken } from '../utils/tokens.js';
import { servePublicListingUpload } from '../utils/ownerDocuments.js';

// Intentionally never import server/env.js or server/server.js. These tests only
// connect to a newly created local replica set, never the project's configured DB.
process.env.JWT_SECRET = randomBytes(48).toString('hex');
let mongo, server, origin, renter, host, admin, stranger;
const fixtureName = `security-test-${randomUUID()}.png`;
const fixturePath = fileURLToPath(new URL(`../uploads/${fixtureName}`, import.meta.url));
const fixtureBytes = Buffer.from('private-test-document');
const account = role => User.create({ name: `Test ${role}`, email: `${randomUUID()}@example.test`, password: 'test-password-only', role });
const vehicle = () => Listing.create({ name: 'Test car', type: 'vehicle', location: 'Mumbai', price: 1000, host: host._id });
const auth = user => user ? { Authorization: `Bearer ${generateToken(user._id)}` } : {};
async function request(url, { user, method = 'GET', body } = {}) {
  const response = await fetch(`${origin}${url}`, {
    method, headers: { ...auth(user), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json();
  return { status: response.status, data };
}
const bookingBody = listing => ({ listingId: String(listing._id), startDate: '2030-01-01', endDate: '2030-01-03', fulfilment: 'pickup' });
async function pending(listing, dates = {}) {
  const result = await request('/api/bookings', { user: renter, method: 'POST', body: { ...bookingBody(listing), ...dates } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
const confirm = (booking, user = host) => request(`/api/bookings/${booking._id}/confirm`, { user, method: 'PUT' });

before(async () => {
  mongo = await MongoMemoryReplSet.create({
    binary: { downloadDir: path.join(os.tmpdir(), 'rentsphere-test-mongodb') },
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  await mongoose.connect(mongo.getUri(), { dbName: `rentsphere_test_${randomUUID().replaceAll('-', '')}` });
  await Promise.all([User.init(), Listing.init(), Booking.init(), OwnerDocument.init()]);
  [renter, host, admin, stranger] = await Promise.all(['user', 'owner', 'admin', 'user'].map(account));
  const app = express();
  app.use(express.json());
  app.use('/uploads', servePublicListingUpload);
  app.use('/api/auth', authRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/owner', ownerRoutes);
  app.use('/api/admin', adminRoutes);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir(path.dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, fixtureBytes, { flag: 'wx' });
}, { timeout: 180000 });

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
  await unlink(fixturePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
});

test('normal and owner registration/login retain working JWTs; admin protection remains enforced', async () => {
  const credentials = { name: 'Registered user', email: `${randomUUID()}@example.test`, password: 'test-password-only' };
  const registered = await request('/api/auth/register', { method: 'POST', body: credentials });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.role, 'user');
  const login = await request('/api/auth/login', { method: 'POST', body: credentials });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
  const owner = await request('/api/owner/register', { method: 'POST', body: { ...credentials, email: `${randomUUID()}@example.test` } });
  assert.equal(owner.status, 201);
  assert.equal(owner.data.role, 'owner');
  assert.equal((await request('/api/admin/owners', { user: admin })).status, 200);
  assert.equal((await request('/api/admin/owners', { user: renter })).status, 403);
  assert.equal((await request('/api/bookings/mybookings')).status, 401);
});

test('booking endpoint ignores forged price, delivery charge and status', async () => {
  const listing = await vehicle();
  const booking = await pending(listing, { totalPrice: 1, deliveryCharge: -999, status: 'confirmed', fulfilment: 'delivery', deliveryAddress: 'Mumbai test address' });
  assert.equal(booking.totalPrice, 2300);
  assert.equal(booking.deliveryCharge, 300);
  assert.equal(booking.status, 'pending');
  const pickup = await pending(listing, { endDate: '2030-01-01', totalPrice: 0, deliveryCharge: 999 });
  assert.equal(pickup.totalPrice, 1000);
  assert.equal(pickup.deliveryCharge, 0);
  const invalid = await request('/api/bookings', { user: renter, method: 'POST', body: { ...bookingBody(listing), endDate: '2029-12-31' } });
  assert.equal(invalid.status, 400);
  const missingAddress = await request('/api/bookings', { user: renter, method: 'POST', body: { ...bookingBody(listing), fulfilment: 'delivery' } });
  assert.equal(missingAddress.status, 400);
});

test('only one concurrent overlapping confirmation succeeds; unauthorized confirmation fails', async () => {
  const listing = await vehicle();
  const first = await pending(listing);
  const second = await pending(listing);
  assert.equal((await confirm(first, stranger)).status, 403);
  const results = await Promise.all([confirm(first), confirm(second, admin)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(await Booking.countDocuments({ listing: listing._id, status: 'confirmed' }), 1);
  const blocked = await request('/api/bookings', { user: renter, method: 'POST', body: bookingBody(listing) });
  assert.equal(blocked.status, 409);
  // Return day is occupied; the following calendar day remains available.
  const boundary = await request('/api/bookings', { user: renter, method: 'POST', body: { ...bookingBody(listing), startDate: '2030-01-03' } });
  assert.equal(boundary.status, 409);
  const next = await pending(listing, { startDate: '2030-01-04', endDate: '2030-01-04' });
  assert.equal((await confirm(next)).status, 200);
});

test('cancelled and rejected requests leave dates available; cancelled requests cannot be confirmed', async () => {
  const listing = await vehicle();
  const first = await pending(listing);
  assert.equal((await confirm(first)).status, 200);
  assert.equal((await request(`/api/bookings/${first._id}/cancel`, { user: renter, method: 'PUT' })).status, 200);
  assert.equal((await confirm(first)).status, 409);
  const rejected = await pending(listing);
  await Booking.updateOne({ _id: rejected._id }, { status: 'rejected' });
  assert.equal((await confirm(rejected)).status, 409);
  assert.equal((await confirm(await pending(listing))).status, 200);
});

test('new documents are private, readable by owner/admin, and preserve verification workflow', async () => {
  const form = new FormData();
  form.append('idProofType', 'Test identity');
  form.append('idProofNumber', 'test-id');
  form.append('documents', new Blob([fixtureBytes], { type: 'image/png' }), 'identity.png');
  const uploaded = await fetch(`${origin}/api/owner/documents`, { method: 'POST', headers: auth(host), body: form });
  assert.equal(uploaded.status, 200);
  const body = await uploaded.json();
  assert.match(body.ownerProfile.documents[0], /^owner-document:/);
  assert.equal(await OwnerDocument.countDocuments({ owner: host._id }), 1);
  const url = `/api/owner/documents/${host._id}/0`;
  assert.equal((await fetch(`${origin}${url}`)).status, 401);
  assert.equal((await fetch(`${origin}${url}`, { headers: auth(stranger) })).status, 403);
  for (const user of [host, admin]) {
    const downloaded = await fetch(`${origin}${url}`, { headers: auth(user) });
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), fixtureBytes);
  }
  assert.equal((await request('/api/owner/submit', { user: host, method: 'POST' })).status, 200);
  const approved = await request(`/api/admin/owners/${host._id}/approve`, { user: admin, method: 'PUT' });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.ownerProfile.status, 'approved');
});

test('legacy files lose public access even if also referenced by a listing; listing images still work', async () => {
  const listing = await vehicle();
  await Listing.updateOne({ _id: listing._id }, { image: `/uploads/${fixtureName}` });
  assert.equal((await fetch(`${origin}/uploads/${fixtureName}`)).status, 200);
  const legacy = await account('owner');
  legacy.ownerProfile.documents = [`/uploads/${fixtureName}`, `data:image/png;base64,${fixtureBytes.toString('base64')}`];
  await legacy.save();
  assert.equal((await fetch(`${origin}/uploads/${fixtureName}`)).status, 404);
  for (const index of [0, 1]) {
    const result = await fetch(`${origin}/api/owner/documents/${legacy._id}/${index}`, { headers: auth(legacy) });
    assert.equal(result.status, 200);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), fixtureBytes);
  }
  assert.equal((await fetch(`${origin}/api/owner/documents/${legacy._id}/99`, { headers: auth(admin) })).status, 404);
  assert.equal((await fetch(`${origin}/uploads/%2e%2e%5c.env`)).status, 404);
});
