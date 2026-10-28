import { configureDeliveryQuotes, fixtureDeliveryBody, testPickup, testDeliveryCharge } from './helpers/deliveryQuoteFixture.js';
import { hostingFixture } from './helpers/hostingFixture.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import sharp from 'sharp';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
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
import listingRoutes from '../routes/listings.js';
import { generateToken } from '../utils/tokens.js';
import { servePublicListingUpload } from '../utils/ownerDocuments.js';
import { deleteListingFiles } from '../utils/uploadImages.js';

// Intentionally never import server/env.js or server/server.js. These tests only
// connect to a newly created local replica set, never the project's configured DB.
process.env.JWT_SECRET = randomBytes(48).toString('hex');
let mongo, server, origin, renter, host, admin, stranger;
const fixtureName = `security-test-${randomUUID()}.png`;
let fixturePath, fixtureDirectory;
const fixtureBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#2477a8' } }).png().toBuffer();
const account = role => User.create({ name: `Test ${role}`, email: `${randomUUID()}@example.test`, password: 'test-password-only', role,
  ...(role === 'owner' ? { ownerProfile: { status: 'approved', listingIntent: 'both' } } : {}) });
const vehicle = () => Listing.create({ name: 'Test car', type: 'vehicle', location: 'Mumbai', price: 1000, host: host._id, locationCoordinates: testPickup });
const auth = user => user ? { Authorization: `Bearer ${generateToken(user._id)}` } : {};
async function request(url, { user, method = 'GET', body } = {}) {
  if (url === '/api/bookings' && method === 'POST' && body) body = await fixtureDeliveryBody(body, value => request('/api/bookings/delivery-quote', { user, method: 'POST', body: value }));
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
  const app = express(); configureDeliveryQuotes(app);
  fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'rentsphere-upload-security-'));
  fixturePath = path.join(fixtureDirectory, fixtureName);
  app.locals.listingUploadDirectory = fixtureDirectory;
  app.use(express.json());
  app.use('/uploads', servePublicListingUpload);
  app.use('/api/auth', authRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/owner', ownerRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/listings', listingRoutes);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir(path.dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, fixtureBytes, { flag: 'wx' });
}, { timeout: 180000 });

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
  if (fixturePath) await unlink(fixturePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

test('normal and owner registration/login retain working JWTs; admin protection remains enforced', async () => {
  const credentials = { name: 'Registered user', email: `${randomUUID()}@example.test`, password: 'test-password-only' };
  const registered = await request('/api/auth/register', { method: 'POST', body: credentials });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.role, 'user');
  const login = await request('/api/auth/login', { method: 'POST', body: credentials });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
  const owner = await request('/api/owner/register', { method: 'POST', body: { ...credentials, phone: '9876543210', email: `${randomUUID()}@example.test` } });
  assert.equal(owner.status, 201);
  assert.equal(owner.data.role, 'owner');
  assert.equal((await request('/api/admin/owners', { user: admin })).status, 200);
  assert.equal((await request('/api/admin/owners', { user: renter })).status, 403);
  assert.equal((await request('/api/bookings/mybookings')).status, 401);
});

test('booking endpoint ignores forged price, delivery charge and status', async () => {
  const listing = await vehicle();
  const booking = await pending(listing, { totalPrice: 1, deliveryCharge: -999, status: 'confirmed', fulfilment: 'delivery', deliveryAddress: 'Mumbai test address' });
  assert.equal(booking.totalPrice, 2000 + testDeliveryCharge);
  assert.equal(booking.deliveryCharge, testDeliveryCharge);
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
  const second = await pending(listing, { startDate: '2030-01-02' });
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

test('new documents are private, readable only by admins, and preserve verification workflow', async () => {
  const applicant = await account('owner');
  await User.updateOne({ _id: applicant._id }, { $set: { 'ownerProfile.status': 'in_progress', 'ownerProfile.phone': '9876543210', 'ownerProfile.address': 'Disposable address', 'ownerProfile.city': 'Mumbai', 'ownerProfile.state': 'Maharashtra', 'ownerProfile.bio': 'Test bio' } });
  const form = new FormData();
  form.append('idProofType', 'Aadhaar Card');
  form.append('idProofNumber', 'test-id');
  form.append('documents', new Blob([fixtureBytes], { type: 'image/png' }), 'identity.png');
  const uploaded = await fetch(`${origin}/api/owner/documents`, { method: 'POST', headers: auth(applicant), body: form });
  assert.equal(uploaded.status, 200);
  const body = await uploaded.json();
  assert.match(body.ownerProfile.documents[0], /^owner-document:/);
  assert.equal(await OwnerDocument.countDocuments({ owner: applicant._id }), 1);
  const url = `/api/owner/documents/${applicant._id}/0`;
  assert.equal((await fetch(`${origin}${url}`)).status, 401);
  assert.equal((await fetch(`${origin}${url}`, { headers: auth(stranger) })).status, 403);
  assert.equal((await fetch(`${origin}${url}`, { headers: auth(applicant) })).status, 403);
  for (const user of [admin]) {
    const downloaded = await fetch(`${origin}${url}`, { headers: auth(user) });
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), fixtureBytes);
  }
  assert.equal((await request('/api/owner/submit', { user: applicant, method: 'POST' })).status, 200);
  const approved = await request(`/api/admin/owners/${applicant._id}/approve`, { user: admin, method: 'PUT' });
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
    const result = await fetch(`${origin}/api/owner/documents/${legacy._id}/${index}`, { headers: auth(admin) });
    assert.equal(result.status, 200);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), fixtureBytes);
  }
  assert.equal((await fetch(`${origin}/api/owner/documents/${legacy._id}/99`, { headers: auth(admin) })).status, 404);
  assert.equal((await fetch(`${origin}/uploads/%2e%2e%5c.env`)).status, 404);
});

const listingBody = { ...hostingFixture(), type: 'property', title: 'Security test property', location: 'Mumbai', price: 12000 };
async function publish(user = host, extra = {}) {
  const result = await request('/api/listings', { user, method: 'POST', body: { ...listingBody, ...extra } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}

test('listing mutation routes reject anonymous/unrelated users before any change', async () => {
  // Publishing first reproduces the former cached-listing authorization bypass.
  const listing = await publish();
  const otherOwner = await account('owner');
  for (const user of [undefined, stranger, otherOwner]) {
    for (const [method, suffix, body] of [
      ['PUT', '', { title: 'Unauthorized change', host: String(stranger._id) }],
      ['POST', '/rent', {}], ['DELETE', '', undefined]
    ]) {
      const result = await request(`/api/listings/${listing._id}${suffix}`, { method, user, body });
      assert.equal(result.status, user ? 403 : 401, JSON.stringify(result.data));
      const visible = await request(`/api/listings/${listing._id}`);
      assert.equal(visible.data.title, listing.title);
      assert.equal(visible.data.status, 'available');
      assert.equal(String(visible.data.host._id), String(host._id));
    }
  }
  assert.equal((await request('/api/listings', { method: 'POST', body: listingBody })).status, 401);
});

test('publishing and management require current database approval, never a token role', async () => {
  const listing = await publish();
  for (const status of ['not_started', 'in_progress', 'pending', 'rejected']) {
    await User.updateOne({ _id: host._id }, { $set: { 'ownerProfile.status': status } });
    try {
      assert.equal((await request('/api/listings', { user: host, method: 'POST', body: listingBody })).status, 403);
      for (const [method, suffix] of [['PUT', ''], ['POST', '/rent'], ['DELETE', '']]) {
        assert.equal((await request(`/api/listings/${listing._id}${suffix}`, { user: host, method, body: { title: 'Blocked' } })).status, 403);
      }
      const booking = await pending(await vehicle());
      assert.equal((await confirm(booking)).status, 403);
    } finally {
      await User.updateOne({ _id: host._id }, { $set: { 'ownerProfile.status': 'approved' } });
    }
  }
  assert.equal((await request('/api/listings', { user: renter, method: 'POST', body: listingBody })).status, 403);
  const ordinaryHost = await Listing.create({ ...listingBody, host: renter._id });
  assert.equal((await request(`/api/listings/${ordinaryHost._id}`, { user: renter, method: 'PUT', body: { price: 10 } })).status, 403);
  await publish(admin);
});

test('owners/admins can edit/rent/delete, but cannot overwrite protected fields', async () => {
  const listing = await publish(host, { host: String(stranger._id), role: 'admin', ownerProfile: { status: 'approved', listingIntent: 'both' } });
  assert.equal(String(listing.host._id), String(host._id));
  for (const user of [host, admin]) {
    for (const field of ['host', 'owner', 'role', '_id', 'id', 'type', 'bookingRevision', 'verified', 'verificationStatus', 'ownerProfile.status', '$set']) {
      const result = await request(`/api/listings/${listing._id}`, { user, method: 'PUT', body: { title: 'Should not apply', [field]: String(stranger._id) } });
      assert.equal(result.status, 400, field);
    }
    const result = await request(`/api/listings/${listing._id}`, { user, method: 'PUT', body: { title: `Edited by ${user.role}`, price: 14000 } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const ownProperty = await publish();
    const rented = await request(`/api/listings/${ownProperty._id}/rent`, { user, method: 'POST', body: {} });
    assert.equal(rented.status, 200);
    assert.equal(rented.data.status, 'rented');
    assert.equal((await request(`/api/listings/${ownProperty._id}/rent`, { user, method: 'POST', body: {} })).status, 409);
    assert.equal((await request(`/api/listings/${ownProperty._id}`, { user, method: 'DELETE' })).status, 200);
    assert.equal((await request(`/api/listings/${ownProperty._id}`)).status, 404);
  }
  const stored = await Listing.findById(listing._id);
  assert.equal(String(stored.host), String(host._id));
  assert.equal(stored.type, 'property');
  assert.equal((await request(`/api/listings/${(await vehicle())._id}/rent`, { user: host, method: 'POST', body: {} })).status, 400);
});

test('failed database writes never return successful temporary listings or stale mutations', async t => {
  const listing = await publish();
  const fail = () => { throw new Error('Simulated database write failure'); };
  const cases = [
    ['create', '/api/listings', 'POST', listingBody],
    ['findOneAndUpdate', `/api/listings/${listing._id}`, 'PUT', { title: 'Failed update' }],
    ['findOneAndDelete', `/api/listings/${listing._id}`, 'DELETE', undefined]
  ];
  for (const [methodName, url, method, body] of cases) {
    t.mock.method(Listing, methodName, fail);
    try { assert.equal((await request(url, { user: host, method, body })).status, 503); }
    finally { t.mock.restoreAll(); }
    assert.equal((await request(`/api/listings/${listing._id}`)).data.title, listing.title);
  }
  t.mock.method(Listing, 'findOneAndUpdate', () => ({ populate: async () => fail() }));
  try {
    assert.equal((await request(`/api/listings/${listing._id}/rent`, { user: host, method: 'POST', body: {} })).status, 503);
  } finally { t.mock.restoreAll(); }
  assert.equal((await Listing.findById(listing._id)).status, 'available');
  assert.equal((await request('/api/listings', { user: host, method: 'POST', body: { ...listingBody, price: -1, location: '' } })).status, 400);
});

test('confirmation retries are idempotent; terminal/cross-customer cancellations are rejected', async () => {
  const booking = await pending(await vehicle());
  assert.equal((await request(`/api/bookings/${booking._id}/confirm`, { method: 'PUT' })).status, 401);
  assert.equal((await confirm(booking, renter)).status, 403);
  assert.equal((await confirm(booking)).status, 200);
  assert.equal((await confirm(booking)).status, 200);
  for (const user of [stranger, host, admin]) {
    assert.equal((await request(`/api/bookings/${booking._id}/cancel`, { user, method: 'PUT' })).status, 403);
  }
  const results = await Promise.all([1, 2].map(() => request(`/api/bookings/${booking._id}/cancel`, { user: renter, method: 'PUT' })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await confirm(booking)).status, 409);
  const rejected = await pending(await vehicle());
  await Booking.updateOne({ _id: rejected._id }, { status: 'rejected' });
  assert.equal((await request(`/api/bookings/${rejected._id}/cancel`, { user: renter, method: 'PUT' })).status, 409);
  assert.equal((await confirm(rejected)).status, 409);
});

test('concurrent property rent requests and booking confirmation/cancellation cannot overwrite decisions', async () => {
  const listing = await publish();
  const rented = await Promise.all([host, admin].map(user => request(`/api/listings/${listing._id}/rent`, { user, method: 'POST', body: {} })));
  assert.deepEqual(rented.map(r => r.status).sort(), [200, 409]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const booking = await pending(await vehicle());
    const [confirmation, cancellation] = await Promise.all([
      confirm(booking), request(`/api/bookings/${booking._id}/cancel`, { user: renter, method: 'PUT' })
    ]);
    assert.ok([200, 409].includes(confirmation.status));
    assert.ok([200, 409].includes(cancellation.status));
    const stored = await Booking.findById(booking._id);
    if (cancellation.status === 200) {
      assert.equal(stored.status, 'cancelled');
      assert.equal((await confirm(booking)).status, 409);
    } else {
      assert.equal(confirmation.status, 200);
      assert.equal(stored.status, 'confirmed');
    }
  }
});

// Send slowly enough that authorization finishes while an image is still being
// transmitted, as happens with larger browser uploads through the Vite proxy.
async function streamedListingUpload(user, target = origin, size = 2 * 1024 * 1024) {
  const boundary = `upload-test-${randomUUID()}`;
  let fullySent = false;
  const sendingController = new AbortController();
  const req = http.request(`${target}/api/listings`, {
    method: 'POST', headers: { ...auth(user), 'Content-Type': `multipart/form-data; boundary=${boundary}` }
  });
  const response = new Promise((resolve, reject) => {
    req.once('error', reject);
    req.once('response', res => {
      const sentBeforeResponse = fullySent;
      sendingController.abort();
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.once('error', reject);
      res.once('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body), sentBeforeResponse }); }
        catch (error) { reject(error); }
      });
    });
  });
  const sending = (async () => {
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="stream.png"\r\nContent-Type: image/png\r\n\r\n`);
    for (let sent = 0; sent < size; sent += 65536) {
      if (!req.write(Buffer.alloc(Math.min(65536, size - sent), 1))) await once(req, 'drain', { signal: sendingController.signal });
      await delay(5, undefined, { signal: sendingController.signal });
    }
    fullySent = true;
    req.end(`\r\n--${boundary}--\r\n`);
  })().catch(error => { if (error.name !== 'AbortError') throw error; });
  try {
    const [result] = await Promise.all([response, sending]);
    return result;
  } finally { req.destroy(); }
}

test('multipart authorization drains images before returning JSON 403, without storing uploads', async () => {
  const beforeFiles = await readdir(path.resolve(fixtureDirectory)).catch(() => []);
  const beforeCount = await Listing.countDocuments();
  const result = await streamedListingUpload(renter);
  assert.equal(result.status, 403);
  assert.match(result.data.message, /approval/i);
  assert.equal(result.sentBeforeResponse, true, 'Do not end the response while the client is still uploading');
  assert.deepEqual(await readdir(path.resolve(fixtureDirectory)).catch(() => []), beforeFiles);
  assert.equal(await Listing.countDocuments(), beforeCount);
});

test('multipart JSON denials survive the Vite development proxy, including oversized unauthorized images', async () => {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: false, envDir: false, appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null,
      proxy: { '/api': { target: origin, changeOrigin: true } } }
  });
  const proxy = http.createServer(vite.middlewares);
  try {
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
    const result = await streamedListingUpload(renter, proxyOrigin, 6 * 1024 * 1024);
    assert.equal(result.status, 403);
    assert.match(result.data.message, /approval/i);
    assert.equal(result.sentBeforeResponse, true);
    const anonymous = await streamedListingUpload(undefined, proxyOrigin);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.sentBeforeResponse, true);
  } finally {
    await new Promise(resolve => proxy.close(resolve));
    await vite.close();
  }
});

function listingForm(files) {
  const form = new FormData();
  for (const [name, value] of Object.entries(listingBody)) form.append(name, (Array.isArray(value) || (value && typeof value === 'object')) ? JSON.stringify(value) : String(value));
  for (const { name = 'image.png', type = 'image/png', size, bytes = fixtureBytes } of files) {
    form.append('images', new Blob([size > 5 * 1024 * 1024 ? Buffer.alloc(size, 1) : bytes], { type }), name);
  }
  return form;
}

test('approval denial precedes multipart file validation for normal, pending and rejected users', async () => {
  const applicant = await account('owner');
  const beforeFiles = await readdir(path.resolve(fixtureDirectory)).catch(() => []);
  const beforeCount = await Listing.countDocuments();
  for (const status of ['pending', 'rejected']) {
    await User.updateOne({ _id: applicant._id }, { $set: { 'ownerProfile.status': status } });
    for (const user of [renter, applicant]) {
      const response = await fetch(`${origin}/api/listings`, {
        method: 'POST', headers: auth(user), body: listingForm([{ type: 'application/pdf', name: 'proof.pdf' }])
      });
      assert.equal(response.status, 403);
      assert.match((await response.json()).message, /approval/i);
    }
  }
  assert.equal(await Listing.countDocuments(), beforeCount);
  assert.deepEqual(await readdir(path.resolve(fixtureDirectory)).catch(() => []), beforeFiles);
});

test('approved owners retain multi-image uploads, and upload errors return JSON without creating listings', async () => {
  const response = await fetch(`${origin}/api/listings`, {
    method: 'POST', headers: auth(host), body: listingForm([{ size: 128 }, { name: 'second.png', size: 256 }])
  });
  const listing = await response.json();
  const uploadedPaths = (listing.gallery || []).map(url => path.resolve(fixtureDirectory, path.basename(url)));
  try {
    assert.equal(response.status, 201, JSON.stringify(listing));
    assert.equal(listing.gallery.length, 2);
    assert.deepEqual(await readFile(uploadedPaths[0]), fixtureBytes);
    assert.deepEqual(await readFile(uploadedPaths[1]), fixtureBytes);
    assert.equal((await Listing.findById(listing._id)).gallery.length, 2);
    const visible = await fetch(`${origin}${listing.gallery[0]}`);
    assert.equal(visible.status, 200);
    assert.deepEqual(Buffer.from(await visible.arrayBuffer()), fixtureBytes);
  } finally {
    await Promise.all(uploadedPaths.map(filename => unlink(filename)));
  }
  const beforeFiles = await readdir(path.resolve(fixtureDirectory));
  const beforeCount = await Listing.countDocuments();
  for (const [files, status] of [
    [[{ type: 'application/pdf', name: 'not-image.pdf' }], 400],
    [[{ size: 5 * 1024 * 1024 + 1 }], 413],
    [Array.from({ length: 11 }, () => ({})), 400]
  ]) {
    const failed = await fetch(`${origin}/api/listings`, { method: 'POST', headers: auth(host), body: listingForm(files) });
    assert.equal(failed.status, status);
    assert.match(failed.headers.get('content-type'), /application\/json/);
    assert.equal(typeof (await failed.json()).message, 'string');
    assert.equal(await Listing.countDocuments(), beforeCount);
    assert.deepEqual(await readdir(path.resolve(fixtureDirectory)), beforeFiles, 'Multer must clean up rejected uploads');
  }
  const malformed = await fetch(`${origin}/api/listings`, {
    method: 'POST', headers: { ...auth(host), 'Content-Type': 'multipart/form-data' }, body: 'missing boundary'
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await malformed.json()).message, 'string');
  // The server continues serving requests after upload errors.
  assert.equal((await request('/api/listings')).status, 200);
});

test('listing uploads decode real raster content, use safe extensions and serve verified image types with inert headers', async () => {
  for (const [format, type] of [['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'], ['gif', 'image/gif'], ['tiff', 'image/tiff'], ['avif', 'image/avif']]) {
    const bytes = await sharp(fixtureBytes).toFormat(format).toBuffer();
    const response = await fetch(origin + '/api/listings', { method: 'POST', headers: auth(host), body: listingForm([{ name: 'unsafe-original.html', type, bytes }]) });
    const row = await response.json(); assert.equal(response.status, 201, JSON.stringify(row));
    assert.match(row.image, /^\/uploads\/[a-f\d-]+\.(jpg|png|webp|gif|tiff|avif)$/);
    assert.deepEqual(row.gallery, [row.image]);
    const image = await fetch(origin + row.image);
    assert.equal(image.status, 200); assert.ok(image.headers.get('content-type').startsWith(type));
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.match(image.headers.get('content-security-policy'), /sandbox/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  }
});

test('disguised HTML, active SVG, scripts, corrupt image signatures and MIME spoofing leave no listing or upload behind', async () => {
  const count = await Listing.countDocuments(), files = await readdir(fixtureDirectory);
  for (const [bytes, type] of [[Buffer.from('<!DOCTYPE html><script>alert(1)</script>'), 'image/png'], [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/svg+xml'], [Buffer.from('alert(1)'), 'image/jpeg'], [fixtureBytes.subarray(0, 24), 'image/png'], [await sharp(fixtureBytes).jpeg().toBuffer(), 'image/png']]) {
    const response = await fetch(origin + '/api/listings', { method: 'POST', headers: auth(host), body: listingForm([{ name: 'image.png', type, bytes }]) });
    assert.equal(response.status, 400); assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(await Listing.countDocuments(), count); assert.deepEqual(await readdir(fixtureDirectory), files);
  }
  const filename = randomUUID() + '.html', url = '/uploads/' + filename;
  await writeFile(path.join(fixtureDirectory, filename), '<script>alert(1)</script>', { flag: 'wx' });
  await Listing.create({ ...listingBody, host: host._id, image: url });
  const response = await fetch(origin + url);
  assert.equal(response.status, 404); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

const imageReferenceRequest = (user, extra = {}) => request('/api/listings', { user, method: 'POST', body: { ...listingBody, ...extra } });

test('local image reuse requires ownership or admin authorization and deletion retains all shared and archived references', async () => {
  const response = await fetch(origin + '/api/listings', { method: 'POST', headers: auth(host), body: listingForm([{}]) });
  const original = await response.json(); assert.equal(response.status, 201);
  const url = original.image, filename = path.basename(url), file = path.join(fixtureDirectory, filename);
  const otherOwner = await account('owner');
  assert.equal((await imageReferenceRequest(otherOwner, { gallery: [url] })).status, 403);
  const absolute = origin + url + '?image=original';
  assert.equal((await imageReferenceRequest(otherOwner, { gallery: [absolute] })).status, 403);
  const owned = await imageReferenceRequest(host, { gallery: [url] }); assert.equal(owned.status, 201);
  const administrative = await imageReferenceRequest(admin, { gallery: [absolute] }); assert.equal(administrative.status, 201);
  const target = await imageReferenceRequest(otherOwner);
  assert.equal((await request('/api/listings/' + target.data._id, { user: otherOwner, method: 'PUT', body: { gallery: [url] } })).status, 403);
  const ownTarget = await imageReferenceRequest(host);
  assert.equal((await request('/api/listings/' + ownTarget.data._id, { user: host, method: 'PUT', body: { gallery: [url], image: url } })).status, 200);
  const options = { findUpload: name => ({ path: path.join(fixtureDirectory, name) }) };
  assert.equal((await request('/api/listings/' + original._id, { user: host, method: 'DELETE' })).status, 200);
  await deleteListingFiles(original, options); assert.deepEqual(await readFile(file), fixtureBytes);
  await Listing.deleteOne({ _id: owned.data._id });
  await Listing.deleteOne({ _id: ownTarget.data._id });
  await deleteListingFiles(original, options); assert.deepEqual(await readFile(file), fixtureBytes, 'Absolute shared URLs must retain media');
  assert.equal((await fetch(origin + url)).status, 200);
  const archived = await imageReferenceRequest(admin, { gallery: [url] }); assert.equal(archived.status, 201);
  await Listing.updateOne({ _id: archived.data._id }, { $set: { archivedAt: new Date() } });
  await Listing.deleteMany({ _id: { $in: [administrative.data._id, ownTarget.data._id] } });
  await deleteListingFiles(original, options); assert.deepEqual(await readFile(file), fixtureBytes, 'Archived references must retain media too');
  await Listing.deleteOne({ _id: archived.data._id });
  await deleteListingFiles(original, options);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('cleanup fails closed on database errors and concurrent reuse/deletion cannot strand a successful reference', async t => {
  const filename = randomUUID() + '.png', image = '/uploads/' + filename, file = path.join(fixtureDirectory, filename);
  await writeFile(file, fixtureBytes, { flag: 'wx' });
  const options = { findUpload: name => ({ path: path.join(fixtureDirectory, name) }) };
  const failure = t.mock.method(Listing, 'find', () => { throw new Error('Disposable DB failure'); });
  await deleteListingFiles({ image }, options); assert.deepEqual(await readFile(file), fixtureBytes); failure.mock.restore();
  const source = await Listing.create({ ...listingBody, host: host._id, image });
  const failedDeletion = t.mock.method(Listing, 'findOneAndDelete', async () => { throw new Error('Disposable deletion failure'); });
  assert.equal((await request('/api/listings/' + source._id, { user: host, method: 'DELETE' })).status, 503);
  assert.ok(await Listing.exists({ _id: source._id })); assert.deepEqual(await readFile(file), fixtureBytes);
  failedDeletion.mock.restore();
  const [removed, reused] = await Promise.all([
    request('/api/listings/' + source._id, { user: host, method: 'DELETE' }),
    imageReferenceRequest(host, { gallery: [image] }),
  ]);
  assert.ok([200, 409].includes(removed.status)); assert.ok([201, 403, 409].includes(reused.status));
  await deleteListingFiles({ image }, options);
  if (reused.status === 201 || removed.status !== 200) assert.deepEqual(await readFile(file), fixtureBytes);
  else await assert.rejects(readFile(file), { code: 'ENOENT' });
});
