import { configureDeliveryQuotes, fixtureDeliveryBody, testPickup, testDeliveryCharge } from './helpers/deliveryQuoteFixture.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import sharp from 'sharp';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import User from '../models/User.js';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';
import saved from '../routes/saved.js';
import bookings from '../routes/bookings.js';
import { generateToken } from '../utils/tokens.js';
import { hostingFixture } from './helpers/hostingFixture.js';
import { resolveRequestLink } from '../../src/data/requests.js';
import { stagingListingPresentation } from '../utils/stagingParity.js';
import auth from '../routes/auth.js';
import OwnerDocument from '../models/OwnerDocument.js';
import ownerRoutes from '../routes/owner.js';
import { dashboardKind, fetchCurrentAccount } from '../../src/data/account.js';

// In-memory uploads and a disposable local replica set: no Atlas or project media.
process.env.VERCEL = '1';
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const { default: listings } = await import('../routes/listings.js');
const { default: adminRoutes } = await import('../routes/admin.js');
let mongo, server, origin, owner, other, customer, pending, app;
const dbName = 'owner_hosting_disposable_' + randomUUID().replaceAll('-', '');
const listingImageBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#2477a8' } }).png().toBuffer();
before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: join(tmpdir(), 'rentsphere-test-mongodb') }, replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { dbName });
  await Promise.all([User.init(), Listing.init(), Booking.init()]);
  [owner, other, customer, pending] = await Promise.all(['owner', 'owner', 'user', 'owner'].map((role, i) => User.create({ name: 'Disposable owner fixture', email: randomUUID() + '@example.test', password: 'DisposableChosenPassword!', role, ...(role === 'owner' ? { ownerProfile: { status: i === 3 ? 'pending' : 'approved', listingIntent: 'both' } } : {}) })));
  app = express(); configureDeliveryQuotes(app); app.use(express.json());
  app.use('/api/listings', stagingListingPresentation, listings); app.use('/api/saved', saved); app.use('/api/bookings', bookings);
  app.use('/api/auth', auth); app.use('/api/owner', ownerRoutes); app.use('/api/admin', adminRoutes);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = 'http://127.0.0.1:' + server.address().port;
}, { timeout: 180000 });
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo?.stop(); });
async function request(path, { actor = owner, method = 'GET', body } = {}) {
  if (path === '/api/bookings' && method === 'POST' && body) body = await fixtureDeliveryBody(body, value => request('/api/bookings/delivery-quote', { actor, method: 'POST', body: value }));
  const form = body instanceof FormData;
  const res = await fetch(origin + path, { method, headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(actor ? { Authorization: 'Bearer ' + generateToken(actor._id) } : {}) }, ...(body ? { body: form ? body : JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() };
}
const publish = async (type = 'property', extra = {}) => {
  const result = await request('/api/listings', { method: 'POST', body: { ...hostingFixture(type), ...extra } });
  assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
};

test('same direct request link resolves through real authorized history/inbox APIs for visits, pickup and delivery', async () => {
  for (const kind of ['visit', 'pickup', 'delivery']) {
    const listing = await publish(kind === 'visit' ? 'property' : 'vehicle');
    const created = await request(kind === 'visit' ? '/api/bookings/visits' : '/api/bookings', { actor: customer, method: 'POST', body: {
      listingId: listing._id, startDate: '2094-06-01', endDate: '2094-06-03',
      ...(kind === 'delivery' ? { fulfilment: 'delivery', deliveryAddress: 'Disposable delivery address' } : {}) } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const before = await Booking.findById(created.data._id).lean();
    const resolve = actor => resolveRequestLink({ id: created.data._id, account: actor, token: generateToken(actor._id), send: (path, options) => fetch(origin + path, options) });
    const suffix = kind === 'visit' ? 'property' : 'vehicle';
    assert.equal(await resolve(customer), `/dashboard?request=${created.data._id}&view=customer&type=${suffix}`);
    assert.equal(await resolve(owner), `/owner-dashboard?request=${created.data._id}&view=owner&type=${suffix}`);
    // Fresh resolution (new tab/refresh) uses authenticated API data again.
    assert.equal(await resolve(owner), `/owner-dashboard?request=${created.data._id}&view=owner&type=${suffix}`);
    for (const actor of [other, pending]) await assert.rejects(resolve(actor), /unavailable or you do not have access/);
    await assert.rejects(resolveRequestLink({ id: created.data._id, account: customer, token: 'invalid', send: (path, options) => fetch(origin + path, options) }), /Unable to open/);
    assert.deepEqual(await Booking.findById(created.data._id).lean(), before);
    assert.equal((await request(`/api/bookings/${created.data._id}/confirm`, { method: 'PUT' })).status, 200);
    assert.equal((await Booking.findById(created.data._id)).status, 'confirmed');
  }
  await assert.rejects(resolveRequestLink({ id: new mongoose.Types.ObjectId().toString(), account: owner, token: generateToken(owner._id), send: (path, options) => fetch(origin + path, options) }), /unavailable or you do not have access/);
});

test('hosting validates all required property/vehicle fields server-side and never creates defaults or fake ratings', async () => {
  const before = await Listing.countDocuments();
  for (const type of ['property', 'vehicle']) {
    const fields = ['title', 'category', 'location', 'price', 'description', 'phone', ...(type === 'property' ? ['area', 'bhk', 'furnishing', 'floor'] : ['kind', 'fuel', 'transmission', 'seats'])];
    for (const key of fields) {
      const body = hostingFixture(type); delete body[key];
      const result = await request('/api/listings', { method: 'POST', body });
      assert.equal(result.status, 400, type + ':' + key); assert.ok(result.data.message);
    }
    for (const extra of [{ phone: '1234567890' }, { phone: '987654321' }, { price: -1 }, { price: true }, { category: 'Forged category' }, { [type === 'property' ? 'area' : 'seats']: -3 }, { [type === 'property' ? 'bhk' : 'seats']: 1.5 }, { [type === 'property' ? 'amenities' : 'features']: 'not JSON' }, { image: '', gallery: [] }]) {
      assert.equal((await request('/api/listings', { method: 'POST', body: { ...hostingFixture(type), ...extra } })).status, 400, JSON.stringify(extra));
    }
  }
  assert.equal(await Listing.countDocuments(), before);
  for (const actor of [customer, pending]) assert.equal((await request('/api/listings', { actor, method: 'POST', body: hostingFixture() })).status, 403);
});

test('complete listing values and IDs persist across reconnect; Studio zero and bike mappings survive', async () => {
  for (const [type, extra] of [['property', { bhk: 0, area: 421.5, amenities: ['WiFi', 'Lift'] }], ['vehicle', { kind: 'Bike', category: 'Sport bike', seats: 2, features: ['ABS', 'Helmet'] }]]) {
    const row = await publish(type, extra);
    assert.equal(row.rating, 0); assert.equal(row.phone, '9876543210');
    await mongoose.disconnect(); await mongoose.connect(mongo.getUri(), { dbName });
    const stored = await Listing.findById(row._id).lean();
    for (const [key, value] of Object.entries({ ...hostingFixture(type), ...extra })) assert.deepEqual(stored[key], value, key);
    assert.equal(String(stored.host), String(owner._id));
    assert.equal((await request('/api/listings/' + row._id, { actor: null })).data.title, row.title);
    assert.ok((await request('/api/listings/mine')).data.some(x => x._id === row._id));
    assert.ok((await request('/api/listings/mine', { actor: other })).data.every(x => x._id !== row._id));
  }
});

test('multipart edits retain/remove/add image references without deleting original media; every field persists and authorization precedes uploads', async () => {
  for (const type of ['property', 'vehicle']) {
    const row = await publish(type, { gallery: ['https://example.test/first.jpg', 'https://example.test/second.jpg'] });
    const body = new FormData();
    const values = { ...hostingFixture(type), title: 'Edited full ' + type, location: 'Edited full address', price: 1600, description: 'Edited detailed description', phone: '+919876543210', ...(type === 'property' ? { area: 777, bhk: 3, floor: 'Ground floor', furnishing: 'Furnished', amenities: ['Gym', 'WiFi', 'Rooftop access'] } : { kind: 'Bike', category: 'Scooter', fuel: 'Electric', transmission: 'Automatic', seats: 2, features: ['ABS', 'Rear camera'] }) };
    delete values.type; delete values.image;
    for (const [key, value] of Object.entries({ ...values, gallery: [row.gallery[1]] })) body.append(key, (Array.isArray(value) || (value && typeof value === 'object')) ? JSON.stringify(value) : String(value));
    body.append('images', new Blob([listingImageBytes], { type: 'image/png' }), 'fixture.png');
    for (const actor of [other, customer, pending]) assert.equal((await request('/api/listings/' + row._id, { actor, method: 'PUT', body })).status, 403);
    const edited = await request('/api/listings/' + row._id, { method: 'PUT', body });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.gallery[0], row.gallery[1]); assert.match(edited.data.gallery[1], /^data:image\/png;base64,/);
    assert.equal(edited.data.image, row.gallery[1]); assert.equal(edited.data.gallery.length, 2);
    assert.equal((await request('/api/listings/' + row._id)).data.gallery.length, 2);
    const stored = await Listing.findById(row._id).lean();
    for (const [key, value] of Object.entries(values)) assert.deepEqual(stored[key], value, key);
    assert.equal(stored.name, values.title); assert.equal(String(stored.host), String(owner._id));
    for (const invalid of [{ phone: '123' }, { category: 'Fake' }, { [type === 'property' ? 'area' : 'seats']: -1 }, { host: String(other._id) }, { type: type === 'property' ? 'vehicle' : 'property' }]) assert.equal((await request('/api/listings/' + row._id, { method: 'PUT', body: invalid })).status, 400);
    assert.equal((await request('/api/listings/' + row._id, { actor: other, method: 'DELETE' })).status, 403);
    const tampered = new FormData(); tampered.append('gallery', JSON.stringify(['https://example.test/not-owned.jpg']));
    assert.equal((await request('/api/listings/' + row._id, { method: 'PUT', body: tampered })).status, 400);
    const empty = new FormData(); empty.append('gallery', '[]');
    assert.equal((await request('/api/listings/' + row._id, { method: 'PUT', body: empty })).status, 400);
    assert.deepEqual((await Listing.findById(row._id).lean()).gallery, stored.gallery);
  }
});

test('legacy owner editing receives every stored image without changing the untouched public gallery or sample data', async () => {
  const gallery = ['https://example.test/legacy-one.jpg', 'https://example.test/legacy-two.jpg'];
  const legacy = await Listing.create({ ...hostingFixture(), host: owner._id, image: gallery[0], gallery });
  assert.equal(legacy.hostingDetailsVersion, undefined);
  assert.deepEqual((await request('/api/listings/' + legacy._id)).data.gallery, [gallery[0]]);
  const mine = (await request('/api/listings/mine')).data.find(x => x._id === String(legacy._id));
  assert.deepEqual(mine.gallery, gallery);
  assert.deepEqual((await Listing.findById(legacy._id).lean()).gallery, gallery);
  const body = new FormData(); const fields = hostingFixture(); delete fields.type; delete fields.image;
  for (const [key, value] of Object.entries({ ...fields, gallery })) body.append(key, (Array.isArray(value) || (value && typeof value === 'object')) ? JSON.stringify(value) : String(value));
  assert.equal((await request('/api/listings/' + legacy._id, { method: 'PUT', body })).status, 200);
  assert.deepEqual((await request('/api/listings/' + legacy._id)).data.gallery, gallery);
});

test('availability transitions block visits/bookings and safe removal preserves booking, visit and saved-listing references', async () => {
  for (const type of ['property', 'vehicle']) {
    const row = await publish(type); const path = '/api/listings/' + row._id;
    const route = type === 'property' ? '/api/bookings/visits' : '/api/bookings';
    const body = { listingId: row._id, startDate: '2091-03-01', ...(type === 'vehicle' ? { endDate: '2091-03-03' } : {}) };
    const created = await request(route, { actor: customer, method: 'POST', body }); assert.equal(created.status, 201);
    assert.equal((await request(path + '/availability', { method: 'PUT', body: { available: false } })).status, 200);
    assert.equal((await request(route, { actor: customer, method: 'POST', body })).status, 409);
    assert.equal((await request(path + '/availability', { method: 'PUT', body: { available: true } })).data.available, true);
    assert.equal((await request('/api/saved/' + row._id, { actor: customer, method: 'PUT' })).status, 200);
    assert.equal((await request(path, { method: 'DELETE' })).status, 200);
    assert.ok((await Listing.findById(row._id)).archivedAt);
    assert.equal(String((await Booking.findById(created.data._id)).listing), row._id);
    assert.ok((await User.findById(customer._id).select('+savedListings')).savedListings.some(id => String(id) === row._id));
    assert.equal((await request(path, { actor: null })).status, 404);
    assert.ok((await request('/api/bookings/mybookings', { actor: customer })).data.some(x => x._id === created.data._id));
  }
  const savedOnly = await publish();
  await request('/api/saved/' + savedOnly._id, { actor: customer, method: 'PUT' });
  assert.equal((await request('/api/listings/' + savedOnly._id, { method: 'DELETE' })).status, 200);
  assert.ok((await Listing.findById(savedOnly._id)).archivedAt);
  const unreferenced = await publish();
  assert.equal((await request('/api/listings/' + unreferenced._id, { method: 'DELETE' })).status, 200);
  assert.equal(await Listing.findById(unreferenced._id), null);
});

test('verified session refresh reflects pending/rejected/approved roles, protects sensitive fields and preserves credentials', async () => {
  const admin = await User.create({ name: 'Disposable admin', email: randomUUID() + '@example.test', password: 'AdminFixturePassword!', role: 'admin' });
  const applicant = await User.create({ name: 'Application fixture', email: randomUUID() + '@example.test', password: 'ApplicantFixturePassword!', role: 'user' });
  const initial = await User.findById(applicant._id).lean();
  assert.equal((await request('/api/auth/me', { actor: null })).status, 401);
  assert.equal(dashboardKind((await request('/api/auth/me', { actor: admin })).data), 'admin');
  assert.equal(dashboardKind((await request('/api/auth/me', { actor: applicant })).data), 'user');
  assert.equal((await request('/api/owner/start', { actor: applicant, method: 'POST' })).status, 200);
  assert.equal((await request('/api/owner/profile', { actor: applicant, method: 'PUT', body: { phone: '9876543210', address: 'Test address', city: 'Mumbai', state: 'Maharashtra', listingIntent: 'both', bio: 'Fixture' } })).status, 200);
  const proof = new FormData(); proof.append('idProofType', 'PAN Card'); proof.append('idProofNumber', 'Disposable'); proof.append('documents', new Blob(['test'], { type: 'image/png' }), 'proof.png');
  assert.equal((await request('/api/owner/documents', { actor: applicant, method: 'POST', body: proof })).status, 200);
  const submitted = await Promise.all([1, 2].map(() => request('/api/owner/submit', { actor: applicant, method: 'POST' })));
  assert.deepEqual(submitted.map(x => x.status).sort(), [200, 409]);
  assert.equal(dashboardKind((await request('/api/auth/me', { actor: applicant })).data), 'user');
  assert.equal((await request('/api/listings', { actor: applicant, method: 'POST', body: hostingFixture() })).status, 403);
  const adminList = await request('/api/admin/owners', { actor: admin });
  assert.equal(adminList.status, 200); assert.equal(adminList.data.filter(x => String(x._id) === String(applicant._id)).length, 1);
  assert.equal((await request('/api/admin/owners/' + applicant._id + '/reject', { actor: admin, method: 'PUT', body: { note: 'Please provide clearer information.' } })).status, 200);
  const rejected = (await request('/api/auth/me', { actor: applicant })).data;
  assert.equal(rejected.ownerProfile.status, 'rejected'); assert.equal(rejected.ownerProfile.reviewNote, 'Please provide clearer information.');
  assert.equal(dashboardKind(rejected), 'user');
  assert.equal((await request('/api/bookings/owner/requests', { actor: applicant })).status, 403);
  assert.equal((await request('/api/owner/profile', { actor: applicant, method: 'PUT', body: { phone: '9876543210', address: 'Test address', city: 'Mumbai', state: 'Maharashtra', listingIntent: 'both', businessName: 'Fixture', bio: 'Fixture' } })).status, 200);
  assert.equal((await request('/api/owner/submit', { actor: applicant, method: 'POST' })).status, 200);
  const oldToken = generateToken(applicant._id);
  assert.equal((await request('/api/admin/owners/' + applicant._id + '/approve', { actor: admin, method: 'PUT' })).status, 200);
  const response = await fetch(origin + '/api/auth/me', { headers: { Authorization: 'Bearer ' + oldToken } });
  const approved = await response.json(); assert.equal(response.status, 200); assert.equal(dashboardKind(approved), 'owner');
  assert.equal(approved.ownerProfile.status, 'approved');
  for (const field of ['password', 'authVersion', 'savedListings']) assert.equal(approved[field], undefined);
  for (const field of ['documents', 'idProofNumber', 'phone']) assert.equal(approved.ownerProfile[field], undefined);
  const login = await request('/api/auth/login', { actor: null, method: 'POST', body: { email: applicant.email, password: 'ApplicantFixturePassword!' } });
  assert.equal(login.status, 200); assert.equal(login.data.role, 'owner');
  assert.equal(String(approved._id), String(initial._id)); assert.equal((await User.findById(applicant._id)).password, initial.password);
  assert.equal((await request('/api/owner/submit', { actor: applicant, method: 'POST' })).status, 409);
  assert.equal((await request('/api/admin/stats', { actor: applicant })).status, 403);
  await assert.rejects(fetchCurrentAccount('mock-only', async () => new Response(JSON.stringify({ message: 'Try again' }), { status: 503, headers: { 'Content-Type': 'application/json' } })), /Try again/);
});

test('creator can persistently hide cancelled bookings/visits; owner/admin history, availability and original documents survive', async () => {
  const admin = await User.create({ name: 'History admin', email: randomUUID() + '@example.test', password: 'AdminFixturePassword!', role: 'admin' });
  assert.equal((await request('/api/bookings/not-an-id/hide', { method: 'PUT' })).status, 404);
  assert.equal((await request('/api/bookings/' + new mongoose.Types.ObjectId() + '/hide', { method: 'PUT' })).status, 404);
  for (const type of ['vehicle', 'property']) {
    const row = await publish(type);
    const route = type === 'vehicle' ? '/api/bookings' : '/api/bookings/visits';
    const created = await request(route, { actor: customer, method: 'POST', body: { listingId: row._id, startDate: '2092-03-01', ...(type === 'vehicle' ? { endDate: '2092-03-03' } : {}) } });
    assert.equal(created.status, 201);
    const path = '/api/bookings/' + created.data._id;
    assert.equal((await request(path + '/hide', { actor: null, method: 'PUT' })).status, 401);
    assert.ok(['pending', 'confirmed'].includes((await Booking.findById(created.data._id)).status));
    assert.equal((await request(path + '/confirm', { method: 'PUT' })).status, 200);
    assert.equal((await Booking.findById(created.data._id)).status, 'confirmed');
    assert.equal((await request(path + '/cancel', { actor: customer, method: 'PUT' })).status, 200);
    const before = await Booking.findById(created.data._id).lean();
    const beforeListing = await Listing.findById(row._id).lean(); const count = await Booking.countDocuments();
    for (const actor of [owner, other, admin]) assert.equal((await request(path + '/hide', { actor, method: 'PUT' })).status, 403);
    const originalUpdate = Booking.findOneAndUpdate;
    try {
      Booking.findOneAndUpdate = () => { throw new Error('Disposable simulated write failure'); };
      assert.equal((await request(path + '/hide', { actor: customer, method: 'PUT' })).status, 503);
      assert.equal((await Booking.findById(created.data._id)).hiddenFromCustomer, undefined);
    } finally { Booking.findOneAndUpdate = originalUpdate; }
    for (let i = 0; i < 2; i++) assert.equal((await request(path + '/hide', { actor: customer, method: 'PUT' })).status, 200);
    const stored = await Booking.findById(created.data._id).lean();
    assert.equal(stored.hiddenFromCustomer, true); assert.equal(stored.status, 'cancelled');
    for (const [key, value] of Object.entries(before)) if (key !== 'updatedAt') assert.deepEqual(stored[key], value, key);
    assert.equal(await Booking.countDocuments(), count);
    assert.deepEqual(await Listing.findById(row._id).lean(), beforeListing);
    await mongoose.disconnect(); await mongoose.connect(mongo.getUri(), { dbName });
    assert.ok(!(await request('/api/bookings/mybookings', { actor: customer })).data.some(x => x._id === created.data._id));
    const login = await request('/api/auth/login', { actor: null, method: 'POST', body: { email: customer.email, password: 'DisposableChosenPassword!' } });
    assert.equal(login.status, 200);
    const afterLogin = await fetch(origin + '/api/bookings/mybookings', { headers: { Authorization: 'Bearer ' + login.data.token } });
    assert.ok(!(await afterLogin.json()).some(x => x._id === created.data._id));
    assert.ok((await request('/api/bookings/owner/requests')).data.some(x => x._id === created.data._id));
    assert.ok(!(await request('/api/bookings/owner/requests', { actor: other })).data.some(x => x._id === created.data._id));
    assert.ok((await request('/api/admin/bookings', { actor: admin })).data.some(x => x._id === created.data._id));
    if (type === 'property') assert.ok((await request('/api/bookings/owner/visits')).data.some(x => x._id === created.data._id));
    else assert.deepEqual((await request('/api/listings/' + row._id + '/availability?from=2092-03-01&to=2092-03-10')).data.bookedRanges, []);
    assert.equal((await request(route, { actor: customer, method: 'POST', body: { listingId: row._id, startDate: '2092-03-01', ...(type === 'vehicle' ? { endDate: '2092-03-03' } : {}) } })).status, 201);
  }
});

test('approved owners retain personal customer bookings, cancellation and hiding without managing another host listing', async () => {
  const row = await Listing.create({ ...hostingFixture('vehicle'), host: other._id });
  const created = await request('/api/bookings', { method: 'POST', body: { listingId: String(row._id), startDate: '2092-05-01', endDate: '2092-05-03' } });
  assert.equal(created.status, 201);
  assert.ok((await request('/api/bookings/mybookings')).data.some(x => x._id === created.data._id));
  assert.equal((await request('/api/listings/' + row._id, { method: 'PUT', body: { title: 'Forged owner edit' } })).status, 403);
  assert.equal((await request('/api/listings/' + row._id + '/availability', { method: 'PUT', body: { available: false } })).status, 403);
  assert.equal((await request('/api/bookings/' + created.data._id + '/confirm', { method: 'PUT' })).status, 403);
  assert.equal((await request('/api/bookings/' + created.data._id + '/reject', { actor: other, method: 'PUT' })).status, 200);
  assert.equal((await request('/api/bookings/' + created.data._id + '/hide', { method: 'PUT' })).status, 200);
  const fresh = await request('/api/bookings', { method: 'POST', body: { listingId: String(row._id), startDate: '2092-05-01', endDate: '2092-05-03' } });
  assert.equal(fresh.status, 201);
  assert.equal((await request('/api/bookings/' + fresh.data._id + '/cancel', { method: 'PUT' })).status, 200);
  assert.equal((await request('/api/bookings/' + fresh.data._id + '/hide', { method: 'PUT' })).status, 200);
});

test('personal removal supports every status for vehicle/visit records without cancelling, deleting or releasing confirmed dates', async () => {
  for (const type of ['vehicle', 'property']) for (const status of ['pending', 'confirmed', 'rejected', 'cancelled']) {
    const row = await publish(type);
    const booking = await Booking.create({ listing: row._id, user: customer._id, requestType: type === 'property' ? 'property_visit' : 'vehicle', status, startDate: '2095-02-01', endDate: '2095-02-03', totalPrice: 2400 });
    const before = booking.toObject(); const count = await Booking.countDocuments();
    const result = await request('/api/bookings/' + booking._id + '/hide', { actor: customer, method: 'PUT' });
    assert.equal(result.status, 200);
    const after = (await Booking.findById(booking._id)).toObject();
    for (const [key, value] of Object.entries(before)) if (key !== 'updatedAt') assert.deepEqual(after[key], value, key);
    assert.equal(after.hiddenFromCustomer, true); assert.equal(await Booking.countDocuments(), count);
    assert.ok((await request('/api/bookings/owner/requests')).data.some(x => x._id === String(booking._id)));
    assert.ok(!(await request('/api/bookings/mybookings', { actor: customer })).data.some(x => x._id === String(booking._id)));
    if (type === 'vehicle' && status === 'confirmed') {
      const calendar = await request('/api/listings/' + row._id + '/availability?from=2095-02-01&to=2095-02-04');
      assert.equal(calendar.data.bookedRanges.length, 1);
      assert.equal((await request('/api/bookings', { actor: other, method: 'POST', body: { listingId: row._id, startDate: '2095-02-01', endDate: '2095-02-02' } })).status, 409);
    }
  }
});

test('only verified listing owners can hide decided request cards; customer/admin views and reserved dates survive', async () => {
  const admin = await User.create({ name: 'Visibility admin', email: randomUUID() + '@example.test', password: 'AdminFixturePassword!', role: 'admin' });
  for (const type of ['vehicle', 'property']) for (const status of ['pending', 'confirmed', 'rejected', 'cancelled']) {
    const row = await publish(type);
    const booking = await Booking.create({ listing: row._id, user: customer._id, requestType: type === 'property' ? 'property_visit' : 'vehicle', status, startDate: '2095-04-01', endDate: '2095-04-03', totalPrice: 2400 });
    const path = '/api/bookings/' + booking._id + '/hide-owner';
    for (const actor of [customer, other, pending, admin]) assert.equal((await request(path, { actor, method: 'PUT' })).status, 403);
    assert.equal((await request(path, { actor: null, method: 'PUT' })).status, 401);
    assert.equal((await request(path, { method: 'PUT' })).status, status === 'pending' ? 409 : 200);
    const stored = await Booking.findById(booking._id);
    assert.equal(stored.status, status); assert.equal(stored.hiddenFromCustomer, undefined);
    if (status === 'pending') { assert.equal(stored.hiddenFromOwners, undefined); continue; }
    assert.equal((await request(path, { method: 'PUT' })).status, 200);
    assert.equal((await Booking.findById(booking._id)).hiddenFromOwners.length, 1);
    assert.ok(!(await request('/api/bookings/owner/requests')).data.some(x => x._id === String(booking._id)));
    assert.ok((await request('/api/bookings/owner/requests', { actor: admin })).data.some(x => x._id === String(booking._id)));
    assert.ok((await request('/api/admin/bookings', { actor: admin })).data.some(x => x._id === String(booking._id)));
    assert.ok((await request('/api/bookings/mybookings', { actor: customer })).data.some(x => x._id === String(booking._id)));
    if (type === 'vehicle' && status === 'confirmed') assert.equal((await request('/api/listings/' + row._id + '/availability?from=2095-04-01&to=2095-04-04')).data.bookedRanges.length, 1);
    await mongoose.disconnect(); await mongoose.connect(mongo.getUri(), { dbName });
    assert.ok(!(await request('/api/bookings/owner/requests')).data.some(x => x._id === String(booking._id)));
  }
});

test('new decisions create private persisted notifications without backfilling history; dismissal is independent of cards and decisions', async () => {
  for (const type of ['vehicle', 'property']) for (const action of ['confirm', 'reject']) {
    const row = await publish(type);
    const old = await Booking.create({ listing: row._id, user: customer._id, requestType: type === 'property' ? 'property_visit' : 'vehicle', status: 'rejected', startDate: '2096-01-01', endDate: '2096-01-03', totalPrice: 2400 });
    assert.ok(!(await request('/api/bookings/notifications', { actor: customer })).data.some(x => x._id === String(old._id)));
    const created = await request(type === 'vehicle' ? '/api/bookings' : '/api/bookings/visits', { actor: customer, method: 'POST', body: { listingId: row._id, startDate: '2096-02-01', ...(type === 'vehicle' ? { endDate: '2096-02-03' } : {}) } });
    assert.equal(created.status, 201);
    const id = created.data._id;
    assert.equal((await request('/api/bookings/' + id + '/' + action, { method: 'PUT' })).status, 200);
    const updates = await request('/api/bookings/notifications', { actor: customer }); assert.equal(updates.status, 200);
    const notice = updates.data.find(x => x._id === id); assert.ok(notice);
    assert.equal(notice.status, action === 'confirm' ? 'confirmed' : 'rejected'); assert.equal(notice.ownerDecision.status, notice.status);
    assert.ok(notice.ownerDecision.decidedAt); assert.equal(notice.listing._id, row._id);
    assert.equal(notice.contact, undefined); assert.equal(notice.user, undefined);
    assert.ok(!(await request('/api/bookings/notifications', { actor: other })).data.some(x => x._id === id));
    assert.equal((await request('/api/bookings/' + id + '/dismiss-notification', { actor: other, method: 'PUT' })).status, 403);
    assert.equal((await request('/api/bookings/notifications', { actor: null })).status, 401);
    // Removing the card and dismissing the update remain separate operations.
    await request('/api/bookings/' + id + '/hide', { actor: customer, method: 'PUT' });
    assert.ok((await request('/api/bookings/notifications', { actor: customer })).data.some(x => x._id === id));
    for (let i = 0; i < 2; i++) assert.equal((await request('/api/bookings/' + id + '/dismiss-notification', { actor: customer, method: 'PUT' })).status, 200);
    if (action === 'confirm') assert.equal((await request('/api/bookings/' + id + '/confirm', { method: 'PUT' })).status, 200);
    await mongoose.disconnect(); await mongoose.connect(mongo.getUri(), { dbName });
    const login = await request('/api/auth/login', { actor: null, method: 'POST', body: { email: customer.email, password: 'DisposableChosenPassword!' } });
    assert.equal(login.status, 200);
    const afterLogin = await fetch(origin + '/api/bookings/notifications', { headers: { Authorization: 'Bearer ' + login.data.token } });
    assert.ok(!(await afterLogin.json()).some(x => x._id === id));
    const saved = await Booking.findById(id); assert.equal(saved.status, notice.status); assert.ok(saved.ownerDecision.dismissedAt);
    if (type === 'property') assert.equal((await Listing.findById(row._id)).status, 'available');
    assert.equal((await request('/api/bookings/' + old._id + '/dismiss-notification', { actor: customer, method: 'PUT' })).status, 409);
  }
});

test('dismissal preserves a visible history card and notifications tolerate a missing listing', async () => {
  const row = await publish();
  const booking = await Booking.create({ listing: row._id, user: owner._id, requestType: 'property_visit', status: 'confirmed', startDate: '2097-01-01', endDate: '2097-01-01', totalPrice: 0, ownerDecision: { status: 'confirmed', decidedAt: new Date() } });
  await Listing.deleteOne({ _id: row._id }); // Disposable broken-reference fixture only.
  const notices = await request('/api/bookings/notifications');
  assert.equal(notices.status, 200); assert.equal(notices.data.find(x => x._id === String(booking._id)).listing, null);
  assert.equal((await request('/api/bookings/' + booking._id + '/dismiss-notification', { method: 'PUT' })).status, 200);
  assert.ok((await request('/api/bookings/mybookings')).data.some(x => x._id === String(booking._id)));
});

test('admin reuses complete multipart hosting without owner approval, preserving attribution, public details and request routing', async () => {
  const admin = await User.create({ name: 'Disposable admin publisher', email: randomUUID() + '@example.test', password: 'DisposableChosenPassword!', role: 'admin' });
  const userCount = await User.countDocuments();
  for (const kind of ['property', 'Car', 'Bike']) {
    const type = kind === 'property' ? 'property' : 'vehicle';
    const values = { ...hostingFixture(type), ...(kind === 'Bike' ? { kind: 'Bike', category: 'Adventure', seats: 2 } : {}),
      [type === 'property' ? 'amenities' : 'features']: type === 'property' ? ['Parking', 'Custom rooftop terrace'] : kind === 'Bike' ? ['Helmet', 'Custom touring rack'] : ['Bluetooth', 'Custom rear camera'] };
    const body = new FormData();
    for (const [key, value] of Object.entries(values)) body.append(key, (Array.isArray(value) || (value && typeof value === 'object')) ? JSON.stringify(value) : String(value));
    body.append('images', new Blob([listingImageBytes], { type: 'image/png' }), 'first.png');
    body.append('images', new Blob([listingImageBytes], { type: 'image/png' }), 'second.png');
    const created = await request('/api/listings', { actor: admin, method: 'POST', body });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const row = created.data; assert.equal(row.host._id, String(admin._id)); assert.equal(row.host.email, admin.email);
    assert.equal(row.gallery.length, 2); assert.ok(row.gallery.every(image => image.startsWith('data:image/png;base64,')));
    assert.deepEqual(row[type === 'property' ? 'amenities' : 'features'], values[type === 'property' ? 'amenities' : 'features']);
    const publicRow = await request('/api/listings/' + row._id, { actor: null }); assert.equal(publicRow.status, 200); assert.equal(publicRow.data._id, row._id);
    assert.ok((await request('/api/listings?type=' + type, { actor: null })).data.some(item => item._id === row._id));
    assert.ok((await request('/api/admin/listings', { actor: admin })).data.some(item => item._id === row._id));
    const booking = await request('/api/bookings' + (type === 'property' ? '/visits' : ''), { actor: customer, method: 'POST', body: {
      listingId: row._id, startDate: '2099-09-15', endDate: '2099-09-17', fulfilment: 'pickup', contact: { name: 'Disposable customer', email: customer.email, phone: '9876543210' },
    } });
    assert.equal(booking.status, 201, JSON.stringify(booking.data)); assert.equal(booking.data.status, 'pending');
    const inbox = await request('/api/admin/requests?type=' + (type === 'property' ? 'property_visit' : 'vehicle'), { actor: admin });
    assert.ok(inbox.data.some(item => item._id === booking.data._id && item.listing._id === row._id));
  }
  assert.equal(await User.countDocuments(), userCount, 'publishing creates no fake owners');
  assert.equal((await User.findById(admin._id)).role, 'admin');
});

test('vehicle map coordinates persist for owners/admins, update with addresses and never disturb unrelated edits or legacy listings', async () => {
  const admin = await User.create({ name: 'Disposable map admin', email: randomUUID() + '@example.test', password: 'DisposableChosenPassword!', role: 'admin' });
  for (const actor of [owner, admin]) {
    const pin = { lat: 19.076012345, lon: 72.877712345 };
    const body = new FormData();
    for (const [key, value] of Object.entries({ ...hostingFixture('vehicle'), locationCoordinates: pin })) body.append(key, value && typeof value === 'object' ? JSON.stringify(value) : String(value));
    const created = await request('/api/listings', { actor, method: 'POST', body });
    assert.equal(created.status, 201, JSON.stringify(created.data)); assert.deepEqual(created.data.locationCoordinates, pin);
    const id = created.data._id, gallery = created.data.gallery;
    const change = value => request('/api/listings/' + id, { actor, method: 'PUT', body: value });
    assert.equal((await change({ price: 1250 })).status, 200);
    assert.deepEqual((await Listing.findById(id)).locationCoordinates, pin);
    assert.equal((await change({ locationCoordinates: null })).status, 400, 'clearing must accompany the address');
    const replacement = { lat: 18.9501, lon: 72.8302 };
    const edited = await change({ location: 'Confirmed replacement address', locationCoordinates: replacement });
    assert.equal(edited.status, 200); assert.deepEqual(edited.data.locationCoordinates, replacement);
    assert.deepEqual(edited.data.gallery, gallery); assert.equal(String(edited.data.host), String(actor._id));
    assert.equal((await change({ location: 'Manually edited address' })).status, 400);
    assert.deepEqual((await Listing.findById(id)).locationCoordinates, replacement);
    const legacy = (await Listing.create({ ...hostingFixture('vehicle', { legacy: true }), host: owner._id })).toObject();
    assert.equal(legacy.locationCoordinates, undefined);
    assert.equal((await request('/api/listings/' + legacy._id, { method: 'PUT', body: { price: 1400 } })).status, 200);
    assert.equal((await Listing.findById(legacy._id)).locationCoordinates, undefined);
  }
  const pin = { lat: 19.07, lon: 72.87 };
  for (const value of [{ lat: '19', lon: 72 }, { lat: 91, lon: 72 }, { lat: 19, lon: -181 }, { lat: null, lon: 72 }, { lat: 19 }, [19,72], { ...pin, extra: true }]) {
    assert.equal((await request('/api/listings', { method: 'POST', body: { ...hostingFixture('vehicle'), locationCoordinates: value } })).status, 400);
  }
  assert.equal((await request('/api/listings', { method: 'POST', body: { ...hostingFixture('property'), locationCoordinates: pin } })).status, 201);
});

test('Home Delivery quotes preserve coordinates through acceptance while pickup and date blocking remain unchanged', async () => {
  const pin = { lat: 19.055512345, lon: 72.845512345 };
  const listing = await publish('vehicle', { locationCoordinates: { lat: 19.07, lon: 72.87 } });
  const base = { listingId: listing._id, startDate: '2099-12-10', endDate: '2099-12-12', fulfilment: 'delivery', deliveryAddress: 'Customer reviewed map address', deliveryCoordinates: pin };
  const create = body => request('/api/bookings', { actor: customer, method: 'POST', body });
  for (const invalid of [{ lat: true, lon: 72 }, { lat: -91, lon: 72 }, { lat: 19, lon: 181 }, {}, null]) assert.equal((await create({ ...base, deliveryCoordinates: invalid })).status, 400);
  assert.equal((await create({ ...base, fulfilment: 'pickup' })).status, 400);
  const result = await create(base); assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.deepEqual(result.data.deliveryCoordinates, pin); assert.equal(result.data.status, 'pending'); assert.equal(result.data.deliveryCharge, testDeliveryCharge); assert.equal(result.data.totalPrice, listing.price * 2 + testDeliveryCharge);
  const accepted = await request('/api/bookings/' + result.data._id + '/confirm', { method: 'PUT' });
  assert.equal(accepted.status, 200); assert.deepEqual(accepted.data.deliveryCoordinates, pin); assert.equal(accepted.data.deliveryCharge, testDeliveryCharge);
  assert.equal((await request('/api/listings/' + listing._id + '/availability?from=2099-12-10&to=2099-12-12', { actor: null })).data.bookedRanges.length, 1);
  assert.ok((await request('/api/bookings/notifications', { actor: customer })).data.some(row => row._id === result.data._id && row.status === 'confirmed'));
  const pickup = await create({ listingId: listing._id, startDate: '2099-12-20', endDate: '2099-12-22', fulfilment: 'pickup' });
  assert.equal(pickup.status, 201); assert.equal(pickup.data.deliveryCoordinates, undefined); assert.equal(pickup.data.deliveryCharge, 0);
  const manual = await request('/api/bookings/delivery-quote', { actor: customer, method: 'POST', body: { listingId: listing._id, startDate: '2099-12-25', endDate: '2099-12-27', deliveryAddress: 'Manually typed address without a confirmed pin' } });
  assert.equal(manual.status, 400); assert.equal(manual.data.code, 'DELIVERY_LOCATION_REQUIRED');
});

test('real HostingForm multipart submission preserves the exact map pin for Owner/Admin create and vehicle editing', async () => {
  const { readFile } = await import('node:fs/promises');
  const { hostingValues, validateHosting, validateHostingLocation } = await import('../../src/data/hosting.js');
  const source = await readFile(new URL('../../src/components/HostingForm.jsx', import.meta.url), 'utf8');
  const handler = source.match(/const submit = async e => \{[\s\S]*?\n  \};/)?.[0]; assert.ok(handler);
  const createSubmit = new Function('deps', `with (deps) { ${handler}; return submit; }`);
  const admin = await User.create({ name: 'Disposable coordinate regression admin', email: randomUUID() + '@example.test', password: 'DisposableChosenPassword!', role: 'admin' });
  const pin = { lat: 18.957526, lon: 72.841516 };
  const submitForm = async (actor, form, item) => {
    let saved, failure, payload;
    const deps = { form, item, token: generateToken(actor._id), submitLock: { current: false }, allowedTypes: ['property','vehicle'], validateHostingLocation: (values, existing, token) => validateHostingLocation(values, existing, token, (path, options) => fetch(origin + path, options)), validateHosting, hostingValues, FormData,
      retained: item ? [...item.gallery] : [], uploads: item ? [] : [{ file: new Blob([listingImageBytes], { type: 'image/png' }) }], fileInput: { current: null },
      setError: value => { failure = value; }, setSuccess() {}, setBusy() {}, onBusyChange() {}, setForm() {}, setUploads() {}, setRetained() {},
      onSaved: async value => { saved = value; }, fetch: async (path, options) => { payload = options.body.get('locationCoordinates'); return fetch(origin + path, options); } };
    await createSubmit(deps)({ preventDefault() {} });
    assert.equal(failure, '', 'real HostingForm failed: ' + failure);
    assert.ok(saved?._id); assert.deepEqual(JSON.parse(payload), form.locationCoordinates);
    return saved;
  };
  for (const actor of [owner, admin]) {
    const created = await submitForm(actor, { ...hostingValues(hostingFixture('vehicle')), location: 'Reviewed map address', locationCoordinates: pin });
    assert.deepEqual(created.locationCoordinates, pin); assert.equal(created.host._id, String(actor._id));
    assert.deepEqual((await Listing.findById(created._id)).locationCoordinates, pin);
    const replacement = { lat: 18.960123456, lon: 72.850123456 };
    const edited = await submitForm(actor, { ...hostingValues(created), location: 'Updated map address', locationCoordinates: replacement }, created);
    assert.deepEqual(edited.locationCoordinates, replacement); assert.deepEqual(edited.gallery, created.gallery);
    assert.equal(String(edited.host), String(actor._id));
    assert.equal((await request('/api/listings/' + created._id, { actor, method: 'PUT', body: { location: 'Manually changed address', locationCoordinates: null } })).status, 400);
    assert.deepEqual((await Listing.findById(created._id)).locationCoordinates, replacement);
  }
});


test('hosting boundary is authoritative for both types and roles; unchanged legacy locations survive while changed locations need valid pins', async () => {
  const admin = await User.create({ name: 'Boundary administrator', email: randomUUID() + '@example.test', password: 'DisposableChosenPassword!', role: 'admin' });
  const pin = { lat: 19.07, lon: 72.87 }, outside = { lat: 28.6, lon: 77.2 };
  const outsideMessage = 'This location is outside the RentSphere service area. Please choose a supported location on the map.';
  for (const actor of [owner, admin]) for (const type of ['property', 'vehicle']) {
    const count = await Listing.countDocuments();
    for (const [coordinates, status] of [[undefined,400],[null,400],[{lat:'19',lon:72},400],[outside,422]]) {
      const result = await request('/api/listings', { actor, method:'POST', body:{...hostingFixture(type),locationCoordinates:coordinates} });
      assert.equal(result.status,status,JSON.stringify(result.data));
      if (status === 422) assert.equal(result.data.message,outsideMessage);
    }
    assert.equal(await Listing.countDocuments(),count);
    assert.equal((await request('/api/listings/validate-location',{actor,method:'POST',body:{locationCoordinates:pin}})).data.valid,true);
    assert.equal((await request('/api/listings/validate-location',{actor,method:'POST',body:{locationCoordinates:outside}})).status,422);
    const created = await request('/api/listings',{actor,method:'POST',body:hostingFixture(type)});
    assert.equal(created.status,201); assert.deepEqual(created.data.locationCoordinates,pin);
    const update = body => request('/api/listings/'+created.data._id,{actor,method:'PUT',body});
    assert.equal((await update({location:'Changed outside address',locationCoordinates:outside})).status,422);
    assert.equal((await update({location:'Changed address without a pin'})).status,400);
    assert.equal((await update({location:'Changed address with cleared pin',locationCoordinates:null})).status,400);
    assert.deepEqual((await Listing.findById(created.data._id)).locationCoordinates,pin);
    for (const oldPin of [undefined,outside]) {
      const legacy = await Listing.create({...hostingFixture(type,{legacy:true}),host:actor._id,locationCoordinates:oldPin});
      const result = await request('/api/listings/'+legacy._id,{actor,method:'PUT',body:{price:1300,location:legacy.location,...(oldPin?{locationCoordinates:oldPin}:{})}});
      assert.equal(result.status,200,JSON.stringify(result.data));
      assert.deepEqual((await Listing.findById(legacy._id)).locationCoordinates,oldPin);
    }
  }
  for (const actor of [null,customer,pending]) assert.equal((await request('/api/listings/validate-location',{actor,method:'POST',body:{locationCoordinates:pin}})).status,actor?403:401);
});

const requestRecord = async (listing, actor, day = '10') => {
  const property = listing.type === 'property';
  const result = await request('/api/bookings'+(property?'/visits':''),{actor,method:'POST',body:{listingId:String(listing._id),startDate:'2099-12-'+day,endDate:'2099-12-'+day,fulfilment:'pickup',contact:{name:actor.name,email:actor.email,phone:'9876543210'}}});
  assert.equal(result.status,201,JSON.stringify(result.data)); return result.data;
};
const preservedRequest = row => {
  const result = JSON.parse(JSON.stringify(row));
  for (const key of ['hiddenFromCustomer','hiddenFromOwners','updatedAt']) delete result[key];
  return result;
};

test('Delete All independently persists each outgoing/incoming category and filtered subset, all statuses, without changing history or date blocks', async () => {
  const admin = await User.create({name:'Bulk visibility admin',email:randomUUID()+'@example.test',password:'DisposableChosenPassword!',role:'admin'});
  for (const actor of [customer,other]) {
    const rows = [], listings = {};
    for (const type of ['vehicle','property']) {
      const listing = await publish(type); listings[type] = listing;
      for (const [index,status] of ['pending','confirmed','rejected','cancelled'].entries()) {
        const row = await requestRecord(listing,actor,String(10+index));
        if (status !== 'pending') assert.equal((await request('/api/bookings/'+row._id+'/'+({confirmed:'confirm',rejected:'reject',cancelled:'cancel'}[status]),{actor:status==='cancelled'?actor:owner,method:'PUT'})).status,200);
        rows.push({...row,status,type});
      }
    }
    const snapshots = new Map(await Promise.all(rows.map(async row=>[row._id,preservedRequest(await Booking.findById(row._id).lean())])));
    const hide = (who,direction,kind,ids) => request('/api/bookings/hide-all',{actor:who,method:'PUT',body:{direction,kind,ids}});
    const vehicleIds = rows.filter(row=>row.type==='vehicle').map(row=>row._id), propertyIds=rows.filter(row=>row.type==='property').map(row=>row._id);
    assert.equal((await hide(actor,'customer','vehicle',[vehicleIds[0],propertyIds[0]])).status,403);
    assert.equal((await Booking.findById(vehicleIds[0])).hiddenFromCustomer,undefined,'invalid mixed selection makes no changes');
    assert.equal((await hide(pending,'owner','all',vehicleIds)).status,403);
    assert.equal((await hide(other,'owner','all',vehicleIds)).status,403,'another owner cannot hide incoming requests');
    assert.equal((await hide(actor===customer?other:customer,'customer','vehicle',vehicleIds)).status,403);
    assert.equal((await hide(actor,'customer','vehicle',vehicleIds)).status,200);
    assert.equal((await hide(actor,'customer','vehicle',vehicleIds)).status,200,'retries are idempotent');
    let personal=(await request('/api/bookings/mybookings',{actor})).data;
    assert.ok(vehicleIds.every(id=>!personal.some(row=>row._id===id))); assert.ok(propertyIds.every(id=>personal.some(row=>row._id===id)));
    let incoming=(await request('/api/bookings/owner/requests')).data;
    assert.ok(vehicleIds.every(id=>incoming.some(row=>row._id===id)),'outgoing removal preserves incoming visibility');
    const pendingId=rows.find(row=>row.type==='vehicle'&&row.status==='pending')._id;
    assert.equal((await hide(owner,'owner','vehicle',[pendingId])).status,200,'selected status subset only');
    incoming=(await request('/api/bookings/owner/requests')).data;
    assert.ok(!incoming.some(row=>row._id===pendingId)); assert.ok(vehicleIds.filter(id=>id!==pendingId).every(id=>incoming.some(row=>row._id===id)));
    assert.equal((await hide(owner,'owner','vehicle',vehicleIds)).status,200);
    assert.equal((await hide(owner,'owner','property',propertyIds)).status,200);
    personal=(await request('/api/bookings/mybookings',{actor})).data;
    assert.ok(propertyIds.every(id=>personal.some(row=>row._id===id)),'incoming removal preserves outgoing visibility');
    assert.equal((await hide(actor,'customer','property',propertyIds)).status,200);
    for(const row of rows) assert.deepEqual(preservedRequest(await Booking.findById(row._id).lean()),snapshots.get(row._id));
    for(const type of ['vehicle','property_visit']) {
      const adminRows=(await request('/api/admin/requests?type='+type,{actor:admin})).data;
      assert.ok(rows.filter(row=>(row.type==='vehicle'?'vehicle':'property_visit')===type).every(row=>adminRows.some(value=>value._id===row._id)));
    }
    const availability=(await request('/api/listings/'+listings.vehicle._id+'/availability?from=2099-12-01&to=2099-12-31',{actor:null})).data;
    assert.equal(availability.bookedRanges.length,1,'hiding does not release confirmed dates');
    await mongoose.disconnect(); await mongoose.connect(mongo.getUri(),{dbName});
    assert.ok((await request('/api/bookings/mybookings',{actor})).data.every(row=>!rows.some(value=>value._id===row._id)));
  }
  assert.equal((await request('/api/bookings/hide-all',{method:'PUT',body:{direction:'customer',kind:'vehicle',ids:[]}})).status,400);
});

test('owner calendar release uses actual confirmed booking, preserves historical details and exposes fresh global availability after reconnect', async () => {
  const listing=await publish('vehicle');
  const row=await requestRecord(listing,customer,'20');
  assert.equal((await request('/api/bookings/'+row._id+'/confirm',{method:'PUT'})).status,200);
  const availability='/api/listings/'+listing._id+'/availability?from=2099-12-01&to=2099-12-31';
  const publicCalendar=await request(availability,{actor:null}); assert.ok(publicCalendar.data.bookedRanges.every(range=>!range._id));
  for(const actor of [null,customer,other]) assert.equal((await request(availability+'&manage=true',{actor})).status,actor?403:401);
  const managed=await request(availability+'&manage=true'); assert.ok(managed.data.bookedRanges.some(range=>range._id===row._id));
  const before=await Booking.findById(row._id).lean();
  const release=(actor,id=row._id,selectedDate='2099-12-20')=>request('/api/bookings/'+id+'/release-dates',{actor,method:'PUT',body:{selectedDate}});
  for (const actor of [customer,other,pending]) assert.equal((await release(actor)).status,403);
  assert.equal((await release(owner,row._id,'2099-12-21')).status,400);
  assert.equal((await release(owner,row._id,'2000-01-01')).status,400);
  assert.equal((await Booking.findById(row._id)).status,'confirmed');
  const results=await Promise.all([release(owner),release(owner)]); assert.ok(results.every(result=>result.status===200));
  const after=await Booking.findById(row._id).lean(); assert.equal(after.status,'cancelled');
  for(const key of ['user','listing','startDate','endDate','totalPrice','deliveryCharge','deliveryAddress','deliveryQuote','vehicleSnapshot','createdAt','requestId','contact']) assert.deepEqual(after[key],before[key],key);
  assert.equal((await request(availability,{actor:null})).data.bookedRanges.length,0);
  assert.equal((await Listing.findById(listing._id)).available,listing.available,'release does not change overall listing availability');
  assert.equal((await request('/api/bookings/mybookings',{actor:customer})).data.find(value=>value._id===row._id).status,'cancelled');
  assert.ok((await request('/api/bookings/notifications',{actor:customer})).data.some(value=>value._id===row._id&&value.status==='cancelled'));
  await mongoose.disconnect();await mongoose.connect(mongo.getUri(),{dbName});
  assert.equal((await request(availability,{actor:null})).data.bookedRanges.length,0);
  const next=await requestRecord(listing,other,'20');assert.equal((await request('/api/bookings/'+next._id+'/confirm',{method:'PUT'})).status,200,'everyone can reserve released dates');
  const pendingRow=await requestRecord(listing,customer,'22'); assert.equal((await release(owner,pendingRow._id,'2099-12-22')).status,409);
});

test('calendar releases the complete range, keeps other overlapping historical reservations and manual unavailability, and rolls back on failed saves', async t => {
  const listing=await publish('vehicle');
  const create=(start,end)=>Booking.create({user:customer._id,listing:listing._id,requestType:'vehicle',status:'confirmed',startDate:'2099-10-'+start,endDate:'2099-10-'+end,totalPrice:4000,deliveryCharge:300,fulfilment:'delivery',deliveryAddress:'Historical delivery address'});
  const first=await create('20','23'),overlap=await create('23','25');
  const path='/api/listings/'+listing._id+'/availability?from=2099-10-01&to=2099-10-31';
  const release=(id,date)=>request('/api/bookings/'+id+'/release-dates',{method:'PUT',body:{selectedDate:date}});
  t.mock.method(Booking.prototype,'save',async()=>{throw new Error('Disposable save failure');});
  try {assert.equal((await release(first._id,'2099-10-21')).status,503);assert.equal((await Booking.findById(first._id)).status,'confirmed');}
  finally {t.mock.restoreAll();}
  assert.equal((await release(first._id,'2099-10-21')).status,200);
  let ranges=(await request(path,{actor:null})).data.bookedRanges;
  assert.equal(ranges.length,1);assert.equal(ranges[0].startDate.slice(0,10),'2099-10-23');assert.equal((await Booking.findById(overlap._id)).status,'confirmed');
  assert.equal((await request('/api/listings/'+listing._id+'/availability',{method:'PUT',body:{available:false}})).status,200);
  assert.equal((await release(overlap._id,'2099-10-24')).status,200);
  const final=(await request(path,{actor:null})).data;assert.equal(final.available,false);assert.equal(final.bookedRanges.length,0);
});


test('hosting uses the unchanged packaged service-area validator and fails closed on configuration failure', async t => {
  const {deliveryArea}=await import('../utils/deliveryQuotes.js');
  const {fileURLToPath}=await import('node:url');
  const {readFile}=await import('node:fs/promises');
  const manifest=JSON.parse(await readFile(new URL('../config/delivery-service-area.sources.json',import.meta.url),'utf8'));
  const area=await deliveryArea({MUMBAI_DELIVERY_BOUNDARY_FILE:fileURLToPath(new URL('../config/delivery-service-area.geojson',import.meta.url)),MUMBAI_DELIVERY_BOUNDARY_SOURCE:'custom:delivery-service-area.sources.json'});
  t.mock.method(app.locals.deliveryQuoteServices,'area',async()=>area);
  try {
    for(const sample of manifest.regressionSamples) for(const type of ['property','vehicle']) {
      const result=await request('/api/listings',{method:'POST',body:{...hostingFixture(type),location:sample.name,locationCoordinates:sample.pin}});
      assert.equal(result.status,201,sample.name+': '+JSON.stringify(result.data));assert.deepEqual(result.data.locationCoordinates,sample.pin);
    }
    t.mock.restoreAll();
    t.mock.method(app.locals.deliveryQuoteServices,'area',async()=>{throw new Error('Missing boundary configuration');});
    const before=await Listing.countDocuments();
    assert.equal((await request('/api/listings/validate-location',{method:'POST',body:{locationCoordinates:testPickup}})).status,503);
    assert.equal((await request('/api/listings',{method:'POST',body:hostingFixture()})).status,503);
    assert.equal(await Listing.countDocuments(),before);
  } finally {t.mock.restoreAll();}
});


const completeOwnerProfile = {phone:'9876543210',address:'Disposable complete address',city:'Mumbai',state:'Maharashtra',bio:'Disposable owner bio',businessName:'',listingIntent:'both'};
const newApplicant = (extra = {}) => User.create({name:'Owner workflow fixture',email:randomUUID()+'@example.test',password:'ChosenDisposablePassword!',role:'owner',ownerProfile:{...completeOwnerProfile,status:'in_progress',currentStep:2,...extra}});
const proofBody = (withFile = true) => {const body=new FormData();body.append('idProofType','PAN Card');body.append('idProofNumber','Disposable proof');if(withFile)body.append('documents',new Blob(['disposable document'],{type:'image/png'}),'proof.png');return body;};

test('owner validation rejects incomplete profiles/documents, preserves files, and locks submitted/approved applications while rejection permits resubmission', async () => {
  const applicant=await newApplicant(),admin=await User.create({name:'Review admin',email:randomUUID()+'@example.test',password:'DisposableAdminPassword!',role:'admin'});
  const before=await User.findById(applicant._id).lean();
  for(const key of ['phone','address','city','state','bio','listingIntent']) {
    const result=await request('/api/owner/profile',{actor:applicant,method:'PUT',body:{...completeOwnerProfile,[key]:'  '}});
    assert.equal(result.status,400);assert.ok(result.data.errors[key]);
  }
  assert.equal((await request('/api/owner/profile',{actor:applicant,method:'PUT',body:{...completeOwnerProfile,phone:'1234567890'}})).status,400);
  assert.equal((await request('/api/owner/documents',{actor:applicant,method:'POST',body:proofBody(false)})).status,400);
  assert.equal((await request('/api/owner/submit',{actor:applicant,method:'POST'})).status,400);
  assert.deepEqual(await User.findById(applicant._id).lean(),before);
  assert.equal((await request('/api/owner/profile',{actor:applicant,method:'PUT',body:{...completeOwnerProfile,phone:'+91 98765-43210'}})).status,200);
  assert.equal((await request('/api/owner/documents',{actor:applicant,method:'POST',body:proofBody()})).status,200);
  const documents=(await User.findById(applicant._id)).ownerProfile.documents.toObject();
  assert.equal(documents.length,1);
  assert.equal((await request('/api/owner/documents',{actor:applicant,method:'POST',body:proofBody(false)})).status,200,'saved documents need not be uploaded again');
  assert.equal((await request('/api/owner/submit',{actor:applicant,method:'POST'})).status,200);
  for(const status of ['pending','approved']) {
    if(status==='approved')assert.equal((await request('/api/admin/owners/'+applicant._id+'/approve',{actor:admin,method:'PUT'})).status,200);
    const snapshot=await User.findById(applicant._id).lean(),count=await OwnerDocument.countDocuments();
    assert.equal((await request('/api/owner/profile',{actor:applicant,method:'PUT',body:{...completeOwnerProfile,listingIntent:'vehicle'}})).status,409);
    assert.equal((await request('/api/owner/documents',{actor:applicant,method:'POST',body:proofBody()})).status,409);
    assert.equal((await request('/api/owner/submit',{actor:applicant,method:'POST'})).status,409);
    assert.deepEqual(await User.findById(applicant._id).lean(),snapshot);assert.equal(await OwnerDocument.countDocuments(),count);
  }
  // A separate rejected application follows the existing edit/resubmit flow.
  const rejected=await newApplicant({status:'rejected',currentStep:5,reviewNote:'Please clarify',documents,idProofType:'PAN Card',idProofNumber:'Saved proof'});
  assert.equal((await request('/api/owner/profile',{actor:rejected,method:'PUT',body:completeOwnerProfile})).status,200);
  assert.equal((await User.findById(rejected._id)).ownerProfile.reviewNote,'Please clarify');
  assert.equal((await User.findById(rejected._id)).ownerProfile.status,'rejected','editing preserves the rejected status and review note until resubmission');
  assert.equal((await request('/api/owner/submit',{actor:rejected,method:'POST'})).status,200);
  assert.deepEqual((await User.findById(rejected._id)).ownerProfile.documents.toObject(),documents);
});

test('approved category controls creation/editing for both listing types; admin is unrestricted and unknown legacy categories fail closed without changing approvals', async () => {
  const admin=await User.create({name:'Category admin',email:randomUUID()+'@example.test',password:'DisposableAdminPassword!',role:'admin'});
  for(const [intent,types] of [['property',['property']],['Properties / Rooms',['property']],['vehicle',['vehicle']],[' Vehicles ',['vehicle']],['both',['property','vehicle']],['',[]],['unknown',[]]]) {
    const actor=await newApplicant({status:'approved',listingIntent:intent});
    assert.equal((await request('/api/auth/me',{actor})).data.ownerProfile.listingIntent,intent,'verified account refresh must retain the approved category');
    for(const type of ['property','vehicle']) {
      const result=await request('/api/listings',{actor,method:'POST',body:hostingFixture(type)});
      assert.equal(result.status,types.includes(type)?201:403,intent+':'+type+':'+JSON.stringify(result.data));
      const legacy=await Listing.create({...hostingFixture(type),host:actor._id});
      const changed=await request('/api/listings/'+legacy._id,{actor,method:'PUT',body:{price:1400}});
      assert.equal(changed.status,types.includes(type)?200:403);
    }
    const stored=await User.findById(actor._id);assert.equal(stored.ownerProfile.status,'approved');assert.equal(stored.ownerProfile.listingIntent,intent);
  }
  for(const type of ['property','vehicle']) assert.equal((await request('/api/listings',{actor:admin,method:'POST',body:hostingFixture(type)})).status,201);
  const legacyUser=await User.create({name:'Legacy approved user',email:randomUUID()+'@example.test',password:'DisposableLegacyPassword!',role:'user',ownerProfile:{status:'approved',listingIntent:'both'}});
  assert.equal((await request('/api/owner/start',{actor:legacyUser,method:'POST'})).status,409,'historical profile flags cannot promote normal users');
  assert.equal((await User.findById(legacyUser._id)).role,'user');
});

test('admin revocation disables only that owners listings, blocks old sessions and preserves bookings, dates, snapshots and independent visibility', async () => {
  const admin=await User.create({name:'Revocation admin',email:randomUUID()+'@example.test',password:'DisposableAdminPassword!',role:'admin'});
  const actor=await newApplicant({status:'approved'}),items=[];
  for(const type of ['property','vehicle']) {
    const published=await request('/api/listings',{actor,method:'POST',body:hostingFixture(type)});assert.equal(published.status,201);items.push(published.data);
  }
  const unrelated=await publish('vehicle');
  const record=await requestRecord(items[1],customer,'26');
  assert.equal((await request('/api/bookings/'+record._id+'/confirm',{actor,method:'PUT'})).status,200);
  await Booking.updateOne({_id:record._id},{$set:{hiddenFromCustomer:true,hiddenFromOwners:[actor._id]}});
  const saved=await Booking.findById(record._id).lean(),password=(await User.findById(actor._id)).password,otherListing=await Listing.findById(unrelated._id).lean();
  for(const who of [null,customer,other]) assert.equal((await request('/api/admin/owners/'+actor._id+'/revoke',{actor:who,method:'PUT'})).status,who?403:401);
  assert.equal((await request('/api/admin/owners/'+admin._id+'/revoke',{actor:admin,method:'PUT'})).status,400);
  const revoked=await request('/api/admin/owners/'+actor._id+'/revoke',{actor:admin,method:'PUT'});assert.equal(revoked.status,200);
  const account=await User.findById(actor._id);assert.equal(account.role,'user');assert.equal(account.ownerProfile.status,'revoked');assert.equal(account.password,password);
  assert.equal(dashboardKind((await request('/api/auth/me',{actor})).data),'user');
  assert.equal((await request('/api/bookings/owner/requests',{actor})).status,403);
  for(const item of items) {
    assert.equal((await request('/api/listings',{actor,method:'POST',body:hostingFixture(item.type)})).status,403);
    assert.equal((await request('/api/listings/'+item._id,{actor,method:'PUT',body:{price:1500}})).status,403);
    const publicItem=(await request('/api/listings/'+item._id,{actor:null})).data;assert.equal(publicItem.available,false);assert.equal(publicItem.availability,'Unavailable');
    const newRequest=await request('/api/bookings'+(item.type==='property'?'/visits':''),{actor:customer,method:'POST',body:{listingId:item._id,startDate:'2099-12-29',endDate:'2099-12-29',fulfilment:'pickup'}});assert.equal(newRequest.status,409);
    assert.equal((await request('/api/listings/'+item._id+'/availability',{actor:admin,method:'PUT',body:{available:true}})).status,409);
    assert.equal((await request('/api/listings/'+item._id,{actor:admin,method:'PUT',body:{price:1500}})).status,200,'administrative management remains available');
  }
  assert.deepEqual(await Booking.findById(record._id).lean(),saved);assert.deepEqual(await Listing.findById(unrelated._id).lean(),otherListing);
  assert.equal((await request('/api/listings/'+items[1]._id+'/availability?from=2099-12-01&to=2099-12-31',{actor:null})).data.bookedRanges.length,1);
  assert.equal((await request('/api/admin/owners/'+actor._id+'/revoke',{actor:admin,method:'PUT'})).status,409);
  await mongoose.disconnect();await mongoose.connect(mongo.getUri(),{dbName});assert.equal((await User.findById(actor._id)).role,'user');
});

test('publishing racing with revocation cannot leave an active listing behind', async () => {
  const actor=await newApplicant({status:'approved'}),admin=await User.create({name:'Race admin',email:randomUUID()+'@example.test',password:'DisposableAdminPassword!',role:'admin'});
  const [published,revoked]=await Promise.all([request('/api/listings',{actor,method:'POST',body:hostingFixture()}),request('/api/admin/owners/'+actor._id+'/revoke',{actor:admin,method:'PUT'})]);
  assert.equal(revoked.status,200);assert.ok([201,403].includes(published.status),JSON.stringify(published));
  const rows=await Listing.find({host:actor._id});assert.ok(rows.every(row=>row.available===false));
});


test('admin document endpoint securely renders each saved image/PDF and rejects owner/customer access and missing documents', async () => {
  const actor=await newApplicant(),admin=await User.create({name:'Document reviewer',email:randomUUID()+'@example.test',password:'DisposableAdminPassword!',role:'admin'});
  const form=proofBody();form.append('documents',new Blob(['disposable PDF'],{type:'application/pdf'}),'proof.pdf');
  assert.equal((await request('/api/owner/documents',{actor,method:'POST',body:form})).status,200);
  for(const [index,type] of ['image/png','application/pdf'].entries()) {
    const path='/api/owner/documents/'+actor._id+'/'+index;
    for(const who of [null,actor,customer,other]) {const denied=await fetch(origin+path,{headers:who?{Authorization:'Bearer '+generateToken(who._id)}:{}});assert.equal(denied.status,who?403:401);}
    const response=await fetch(origin+path,{headers:{Authorization:'Bearer '+generateToken(admin._id)}});
    assert.equal(response.status,200);assert.ok(response.headers.get('content-type').includes(type));assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.ok(response.headers.get('cache-control').includes('no-store'));assert.ok((await response.arrayBuffer()).byteLength);
  }
  assert.equal((await fetch(origin+'/api/owner/documents/'+actor._id+'/99',{headers:{Authorization:'Bearer '+generateToken(admin._id)}})).status,404);
});


test('real revoked-owner wizard restarts, validates and resubmits the same record without reactivating listings or changing booking history', async () => {
  const {readFile}=await import('node:fs/promises');
  const {ownerProfileErrors,ownerDocumentErrors,ownerFileError}=await import('../../src/data/ownerPolicy.js');
  const actor=await newApplicant(),admin=await User.create({name:'Reapplication reviewer',email:randomUUID()+'@example.test',password:'DisposableReviewPassword!',role:'admin'});
  assert.equal((await request('/api/owner/documents',{actor,method:'POST',body:proofBody()})).status,200);
  assert.equal((await request('/api/owner/submit',{actor,method:'POST'})).status,200);
  assert.equal((await request('/api/admin/owners/'+actor._id+'/approve',{actor:admin,method:'PUT'})).status,200);
  const items=[];for(const type of ['property','vehicle']){const row=await request('/api/listings',{actor,method:'POST',body:hostingFixture(type)});assert.equal(row.status,201);items.push(row.data);}
  const records=[];for(const item of items){const row=await requestRecord(item,customer,'27');assert.equal((await request('/api/bookings/'+row._id+'/confirm',{actor,method:'PUT'})).status,200);records.push(await Booking.findById(row._id).lean());}
  assert.equal((await request('/api/admin/owners/'+actor._id+'/revoke',{actor:admin,method:'PUT'})).status,200);
  const original=await User.findById(actor._id).lean(),count=await User.countDocuments(),docs=original.ownerProfile.documents;
  const source=await readFile(new URL('../../src/components/OwnerOnboarding.jsx',import.meta.url),'utf8');
  const extract=(name,next)=>{const start=source.indexOf('  const '+name+' = '),end=source.indexOf(next,start);assert.ok(start>=0&&end>start);return new Function('deps','with(deps){'+source.slice(start,end)+';return '+name+';}');};
  let step,uiError='',ownerData={_id:String(actor._id),ownerProfile:original.ownerProfile},completed=5;
  const deps={readOnly:false,statusSequence:{current:0},user:{token:generateToken(actor._id)},profileForm:{...completeOwnerProfile,listingIntent:'property'},docForm:{idProofType:original.ownerProfile.idProofType,idProofNumber:original.ownerProfile.idProofNumber},files:[],previewRefs:{current:[]},
    ownerProfileErrors,ownerDocumentErrors,ownerFileError,setSubmitting(){},setError:value=>{uiError=value;},setSuccess(){},setStep:value=>{step=value;},setCompleted:value=>{completed=typeof value==='function'?value(completed):value;},
    setOwnerData:value=>{ownerData=typeof value==='function'?value(ownerData):value;deps.ownerData=ownerData;},login:value=>{deps.user=value;},setFiles(){},setPreviews(){},showErrors:errors=>{uiError=Object.values(errors)[0]||'';return Boolean(uiError);},fetch:(path,options)=>fetch(origin+path,options)};
  await extract('startAsExistingUser','  // ---------- STEP 2:')(deps)();
  assert.equal(uiError,'');assert.equal(step,2);assert.equal(completed,2);assert.equal(ownerData.ownerProfile.status,'in_progress');assert.deepEqual(ownerData.ownerProfile.documents,docs);
  assert.equal((await request('/api/listings',{actor,method:'POST',body:hostingFixture()})).status,403);
  await extract('submitProfile','  // ---------- STEP 3:')(deps)({preventDefault(){}});assert.equal(step,3);assert.equal(uiError,'');
  await extract('submitDocuments','  // ---------- STEP 4:')(deps)({preventDefault(){}});assert.equal(step,4);assert.equal(uiError,'');
  await extract('finalSubmit','  if (loading)')(deps)();assert.equal(uiError,'');assert.equal(step,5);assert.equal(ownerData.ownerProfile.status,'pending');
  assert.equal(await User.countDocuments(),count);assert.equal(String((await User.findById(actor._id))._id),String(original._id));assert.equal((await User.findById(actor._id)).password,original.password);
  assert.ok((await request('/api/admin/owners',{actor:admin})).data.some(row=>row._id===String(actor._id)&&row.ownerProfile.status==='pending'));
  assert.equal((await request('/api/listings',{actor,method:'POST',body:hostingFixture()})).status,403);
  assert.equal((await request('/api/owner/profile',{actor,method:'PUT',body:completeOwnerProfile})).status,409);
  assert.equal((await request('/api/admin/owners/'+actor._id+'/reject',{actor:admin,method:'PUT',body:{note:'Please clarify'}})).status,200);
  assert.equal((await request('/api/owner/submit',{actor,method:'POST'})).status,200,'rejected applications can still resubmit valid saved information');
  assert.equal((await request('/api/admin/owners/'+actor._id+'/approve',{actor:admin,method:'PUT'})).status,200);
  assert.equal((await request('/api/listings',{actor,method:'POST',body:hostingFixture('vehicle')})).status,403);
  assert.equal((await request('/api/listings',{actor,method:'POST',body:hostingFixture('property')})).status,201);
  for(const item of items){const saved=await Listing.findById(item._id);assert.equal(saved.available,false);assert.equal(saved.availability,'Unavailable');}
  for(const record of records)assert.deepEqual(await Booking.findById(record._id).lean(),record);
  const calendar=(await request('/api/listings/'+items[1]._id+'/availability?from=2099-12-01&to=2099-12-31',{actor:null})).data;assert.equal(calendar.bookedRanges.length,1);
});
