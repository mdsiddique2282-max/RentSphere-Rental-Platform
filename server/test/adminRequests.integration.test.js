import { configureDeliveryQuotes, fixtureDeliveryBody, testPickup, testDeliveryCharge } from './helpers/deliveryQuoteFixture.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import User from '../models/User.js';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';
import adminRoutes from '../routes/admin.js';
import listings from '../routes/listings.js';
import bookings from '../routes/bookings.js';
import { stagingInterestWorkflow } from '../utils/stagingParity.js';
import { generateToken } from '../utils/tokens.js';
import { hostingFixture } from './helpers/hostingFixture.js';

// No private environment/configuration imports: only this disposable replica set.
process.env.JWT_SECRET = randomBytes(48).toString('hex');
let mongo, server, origin, admin, owner, otherOwner, customer, stranger;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: join(tmpdir(), 'rentsphere-test-mongodb') }, replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { dbName: 'admin_requests_disposable_' + randomUUID().replaceAll('-', '') });
  await Promise.all([User.init(), Listing.init(), Booking.init()]);
  [admin, owner, otherOwner, customer, stranger] = await Promise.all(['admin', 'owner', 'owner', 'user', 'user'].map(role => User.create({
    name: 'Disposable ' + role, email: randomUUID() + '@example.test', password: 'TestChosenPassword!', role,
    ...(role === 'owner' ? { ownerProfile: { status: 'approved', listingIntent: 'both' } } : {}),
  })));
  const app = express(); configureDeliveryQuotes(app); app.use(express.json());
  app.use('/api/admin', adminRoutes); app.use('/api/listings', listings); app.use('/api/bookings', bookings);
  app.use('/api/preview', stagingInterestWorkflow);
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  origin = 'http://127.0.0.1:' + server.address().port;
}, { timeout: 180000 });
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo?.stop(); });
async function request(path, { actor = admin, method = 'GET', body } = {}) {
  if (path === '/api/bookings' && method === 'POST' && body) body = await fixtureDeliveryBody(body, value => request('/api/bookings/delivery-quote', { actor, method: 'POST', body: value }));
  const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: 'Bearer ' + generateToken(actor._id) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.match(response.headers.get('content-type'), /application\/json/);
  return { status: response.status, data: await response.json() };
}
async function publish(type, actor = owner) {
  const result = await request('/api/listings', { actor, method: 'POST', body: { ...hostingFixture(type), ...(type === 'vehicle' ? { locationCoordinates: testPickup } : {}) } });
  assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
}
async function submit(listing, actor = customer, start = '2098-01-10', end = '2098-01-12') {
  const result = await request('/api/bookings' + (listing.type === 'property' ? '/visits' : ''), { actor, method: 'POST', body: {
    listingId: String(listing._id), startDate: start, endDate: end, fulfilment: listing.type === 'vehicle' && listing.locationCoordinates ? 'delivery' : 'pickup',
    deliveryAddress: 'Disposable full delivery address', contact: { name: 'Actual requester', email: actor.email, phone: '9876543210' },
  } });
  assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
}
const decide = (row, action, actor = admin) => request('/api/admin/requests/' + row._id + '/' + action, { actor, method: 'PUT' });
const archiveRow = row => request('/api/admin/requests/' + row._id + '/archive', { method: 'PUT', body: { archived: true } });
const hideArchived = (type, ids, actor = admin) => request('/api/admin/requests/hide-archived', { actor, method: 'PUT', body: { type, ids } });

test('management endpoints enforce real admin authorization, validate kinds and never expose credentials', async () => {
  for (const actor of [null, customer, owner]) {
    assert.equal((await request('/api/admin/requests?type=vehicle', { actor })).status, actor ? 403 : 401);
    assert.equal((await request('/api/admin/requests/' + new mongoose.Types.ObjectId() + '/confirm', { actor, method: 'PUT' })).status, actor ? 403 : 401);
  }
  assert.equal((await request('/api/admin/requests?type=property_booking')).status, 400);
  assert.equal((await request('/api/admin/requests/invalid/confirm', { method: 'PUT' })).status, 404);
  assert.equal((await request('/api/admin/requests/' + new mongoose.Types.ObjectId() + '/delete', { method: 'PUT' })).status, 400);
  assert.equal((await request('/api/admin/requests?type=property_visit')).data.length, 0);
});

test('owner-uploaded, admin-created and ownerless predefined inventory all appear and can be decided using the original records', async () => {
  const usersBefore = await User.countDocuments();
  for (const type of ['vehicle', 'property']) for (const source of ['owner', 'admin', 'predefined']) {
    let listing;
    if (source === 'predefined') {
      listing = { _id: new mongoose.Types.ObjectId(), ...hostingFixture(type), title: 'Predefined without registered owner', status: 'available',
        // One legacy reference is orphaned; another listing has no host field.
        ...(type === 'vehicle' ? { host: new mongoose.Types.ObjectId() } : {}) };
      await Listing.collection.insertOne(listing);
    } else listing = await publish(type, source === 'owner' ? owner : admin);
    const beforeListing = await Listing.findById(listing._id).lean();
    const booking = await submit(listing);
    const kind = type === 'vehicle' ? 'vehicle' : 'property_visit';
    const inbox = await request('/api/admin/requests?type=' + kind);
    assert.equal(inbox.status, 200);
    const visible = inbox.data.find(row => row._id === booking._id);
    assert.ok(visible); assert.equal(visible.user._id, String(customer._id)); assert.equal(visible.listing._id, String(listing._id));
    assert.equal(visible.contact.phone, '9876543210'); assert.equal(visible.user.password, undefined);
    assert.equal(visible.user.authVersion, undefined); assert.equal(visible.listing.host?.password, undefined);
    if (source === 'owner') assert.ok((await request('/api/bookings/owner/requests', { actor: owner })).data.some(row => row._id === booking._id));
    assert.equal((await request('/api/bookings/' + booking._id + '/confirm', { actor: otherOwner, method: 'PUT' })).status, 403);
    const result = await decide(booking, 'confirm');
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data._id, booking._id); assert.equal(result.data.status, 'confirmed');
    assert.equal((await Booking.findById(booking._id)).status, 'confirmed');
    assert.ok((await request('/api/bookings/mybookings', { actor: customer })).data.some(row => row._id === booking._id && row.status === 'confirmed'));
    assert.ok((await request('/api/bookings/notifications', { actor: customer })).data.some(row => row._id === booking._id && row.ownerDecision.status === 'confirmed'));
    if (source === 'owner') assert.ok((await request('/api/bookings/owner/requests', { actor: owner })).data.some(row => row._id === booking._id && row.status === 'confirmed'));
    const stored = await Listing.findById(listing._id).lean();
    for (const field of ['status', 'available', 'availability']) assert.equal(stored[field], beforeListing[field]);
    assert.equal(String(stored.host), String(beforeListing.host));
    assert.equal((await decide(booking, 'confirm')).status, 409);
    assert.equal((await decide(booking, 'reject')).status, 409);
  }
  assert.equal(await User.countDocuments(), usersBefore, 'no fake owners are created');
});

test('admin vehicle acceptance preserves overlap protection, notifications, partial status and free dates; rejection reserves nothing', async () => {
  const listing = await publish('vehicle');
  const first = await submit(listing), overlap = await submit(listing, stranger, '2098-01-12', '2098-01-14');
  const rejected = await submit(listing, customer, '2098-01-20', '2098-01-22');
  const calendarPath = '/api/listings/' + listing._id + '/availability?from=2098-01-01&to=2098-01-31';
  assert.equal((await request(calendarPath, { actor: null })).data.bookedRanges.length, 0);
  const results = await Promise.all([decide(first, 'confirm'), request('/api/bookings/' + overlap._id + '/confirm', { actor: owner, method: 'PUT' })]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  assert.equal(await Booking.countDocuments({ listing: listing._id, status: 'confirmed' }), 1);
  assert.equal(await Booking.countDocuments({ listing: listing._id, status: 'pending' }), 2);
  assert.equal((await request(calendarPath, { actor: null })).data.bookedRanges.length, 1);
  assert.equal((await request('/api/listings/' + listing._id, { actor: null })).data.vehicleBookingStatus, 'partially-booked');
  assert.equal((await decide(rejected, 'reject')).status, 200);
  assert.ok((await request('/api/bookings/notifications', { actor: customer })).data.some(row => row._id === rejected._id && row.ownerDecision.status === 'rejected'));
  assert.equal((await request('/api/listings/' + listing._id + '/availability?from=2098-01-20&to=2098-01-22', { actor: null })).data.bookedRanges.length, 0);
  assert.equal((await submit(listing, stranger, '2098-01-25', '2098-01-27')).status, 'pending');
});

test('simultaneous conflicting admin/owner decisions are first-commit-wins and stale admin clicks never overwrite them', async () => {
  for (const type of ['vehicle', 'property']) {
    const listing = await publish(type), row = await submit(listing);
    const results = await Promise.all([decide(row, 'confirm'), request('/api/bookings/' + row._id + '/reject', { actor: owner, method: 'PUT' })]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const before = await Booking.findById(row._id).lean();
    assert.ok(['confirmed', 'rejected'].includes(before.status)); assert.equal(before.ownerDecision.status, before.status);
    assert.equal((await decide(row, 'reject')).status, 409); assert.equal((await decide(row, 'confirm')).status, 409);
    assert.deepEqual(await Booking.findById(row._id).lean(), before);
    assert.ok((await request('/api/admin/requests?type=' + (type === 'vehicle' ? 'vehicle' : 'property_visit'))).data.some(item => item._id === row._id && item.status === before.status));
  }
});

test('admin visit decisions preserve interest, owner Make Available, rejection notices and historical requests', async () => {
  const listing = await publish('property'), visit = await submit(listing);
  assert.equal((await decide(visit, 'confirm')).status, 200);
  const access = await request('/api/preview/property-visits/' + listing._id, { actor: customer });
  assert.equal(access.data.requestId, visit._id); assert.equal(access.data.actionable, true);
  assert.equal((await request('/api/preview/property-visits/' + visit._id + '/decision', { actor: customer, method: 'POST', body: { decision: 'interested', confirmedInApp: true } })).status, 200);
  assert.equal((await Listing.findById(listing._id)).available, false);
  const preserved = await Booking.findById(visit._id).lean();
  assert.equal((await request('/api/listings/' + listing._id + '/availability', { actor: owner, method: 'PUT', body: { available: true } })).status, 200);
  assert.equal((await Listing.findById(listing._id)).available, true);
  assert.deepEqual(await Booking.findById(visit._id).lean(), preserved);
  const another = await submit(listing, stranger, '2098-01-25');
  assert.equal((await decide(another, 'reject')).status, 200);
  assert.ok((await request('/api/bookings/notifications', { actor: stranger })).data.some(row => row._id === another._id && row.status === 'rejected'));
  const inbox = await request('/api/admin/requests?type=property_visit');
  assert.equal(inbox.data.find(row => row._id === visit._id).propertyDecision.kind, 'interested');
  assert.equal(await Booking.countDocuments({ listing: listing._id }), 2);
});

test('legacy vehicle requests with no requestType stay visible and actionable without changing their identity or history', async () => {
  const listing = await publish('vehicle'), row = await submit(listing);
  await Booking.collection.updateOne({ _id: new mongoose.Types.ObjectId(row._id) }, { $unset: { requestType: '' } });
  const inbox = await request('/api/admin/requests?type=vehicle');
  assert.ok(inbox.data.some(item => item._id === row._id));
  assert.equal((await decide(row, 'reject')).status, 200);
  assert.equal((await Booking.findById(row._id)).requestType, undefined);
});

test('admin, owner and customer request lists use creation time and stable IDs, retaining order after status changes and refresh', async () => {
  for (const type of ['vehicle', 'property']) {
    const listing = await publish(type);
    const rows = [];
    // Scheduled dates deliberately run backwards; creation order must win.
    for (const day of ['25', '20', '15']) rows.push(await submit(listing, customer, '2099-02-' + day, '2099-02-' + day));
    const createdTimes = ['2001-01-01T10:00:00Z', '2001-01-01T11:00:00Z', '2001-01-01T12:00:00Z'];
    for (let i = 0; i < rows.length; i++) await Booking.collection.updateOne({ _id: new mongoose.Types.ObjectId(rows[i]._id) }, { $set: { createdAt: new Date(createdTimes[i]) } });
    const ids = rows.map(row => row._id), expected = [...ids].reverse();
    const paths = [
      ['/api/admin/requests?type=' + (type === 'vehicle' ? 'vehicle' : 'property_visit'), admin],
      ['/api/bookings/owner/requests', owner], ['/api/bookings/mybookings', customer],
      ...(type === 'property' ? [['/api/bookings/owner/visits', owner]] : []),
    ];
    const check = async order => {
      for (const [path, actor] of paths) {
        const result = await request(path, { actor }); assert.equal(result.status, 200);
        assert.deepEqual(result.data.filter(row => ids.includes(row._id)).map(row => row._id), order, path);
      }
    };
    await check(expected); await check(expected);
    assert.equal((await decide(rows[0], 'reject')).status, 200);
    assert.equal((await request('/api/bookings/' + rows[1]._id + '/confirm', { actor: owner, method: 'PUT' })).status, 200);
    await check(expected); // updatedAt and status must never determine order.
    const latest = await submit(listing, customer, '2099-02-10', '2099-02-10');
    ids.push(latest._id);
    await check([latest._id, ...expected]);
    const equalTime = new Date('2001-01-01T12:00:00Z');
    await Booking.collection.updateMany({ _id: { $in: rows.map(row => new mongoose.Types.ObjectId(row._id)) } }, { $set: { createdAt: equalTime } });
    const tieOrder = rows.map(row => row._id).sort().reverse();
    await check([latest._id, ...tieOrder]); await check([latest._id, ...tieOrder]);
    for (const row of rows) assert.deepEqual((await Booking.findById(row._id)).createdAt, equalTime, 'read requests must not rewrite creation timestamps');
  }
});

test('admin archive is recoverable and preserves history, timestamps, notifications, interest and confirmed date blocking', async () => {
  for (const type of ['vehicle', 'property']) {
    const listing = await publish(type), row = await submit(listing);
    assert.equal((await decide(row, 'confirm')).status, 200);
    if (type === 'property') assert.equal((await request('/api/preview/property-visits/' + row._id + '/decision', { actor: customer, method: 'POST', body: { decision: 'interested', confirmedInApp: true } })).status, 200);
    const before = await Booking.collection.findOne({ _id: new mongoose.Types.ObjectId(row._id) });
    const listingBefore = await Listing.findById(listing._id).lean();
    const history = await request('/api/bookings/mybookings', { actor: customer });
    const ownerHistory = await request('/api/bookings/owner/requests', { actor: owner });
    const notifications = await request('/api/bookings/notifications', { actor: customer });
    const calendar = type === 'vehicle' ? await request('/api/listings/' + listing._id + '/availability?from=2098-01-01&to=2098-01-31', { actor: null }) : null;
    const archive = value => request('/api/admin/requests/' + row._id + '/archive', { method: 'PUT', body: { archived: value } });
    assert.equal((await archive(true)).status, 200); assert.equal((await archive(true)).status, 200);
    const stored = await Booking.collection.findOne({ _id: before._id });
    assert.equal(stored.hiddenFromAdmin, true); delete stored.hiddenFromAdmin; assert.deepEqual(stored, before);
    const path = '/api/admin/requests?type=' + (type === 'vehicle' ? 'vehicle' : 'property_visit');
    assert.ok(!(await request(path)).data.some(item => item._id === row._id));
    assert.ok((await request(path + '&archived=true')).data.some(item => item._id === row._id));
    assert.deepEqual(await request('/api/bookings/mybookings', { actor: customer }), history);
    assert.deepEqual(await request('/api/bookings/owner/requests', { actor: owner }), ownerHistory);
    assert.deepEqual(await request('/api/bookings/notifications', { actor: customer }), notifications);
    assert.deepEqual(await Listing.findById(listing._id).lean(), listingBefore);
    if (calendar) {
      assert.deepEqual(await request('/api/listings/' + listing._id + '/availability?from=2098-01-01&to=2098-01-31', { actor: null }), calendar);
      assert.equal((await request('/api/listings/' + listing._id, { actor: null })).data.vehicleBookingStatus, 'partially-booked');
      for (const available of [false, true]) {
        assert.equal((await request('/api/listings/' + listing._id + '/availability', { method: 'PUT', body: { available } })).status, 200);
        assert.deepEqual((await request('/api/listings/' + listing._id + '/availability?from=2098-01-01&to=2098-01-31', { actor: null })).data.bookedRanges, calendar.data.bookedRanges);
      }
    } else {
      assert.equal((await request('/api/listings/' + listing._id + '/availability', { method: 'PUT', body: { available: true } })).status, 200);
      assert.equal((await Listing.findById(listing._id)).available, true);
    }
    assert.equal((await archive(false)).status, 200);
    assert.ok((await request(path)).data.some(item => item._id === row._id));
    const restored = await Booking.collection.findOne({ _id: before._id });
    assert.equal(restored.hiddenFromAdmin, false); delete restored.hiddenFromAdmin; assert.deepEqual(restored, before);
  }
});

test('archive requires admin and a boolean-only body; pending and rejected requests can be restored', async () => {
  const row = await submit(await publish('property'));
  const path = '/api/admin/requests/' + row._id + '/archive';
  for (const actor of [null, customer, owner]) assert.equal((await request(path, { actor, method: 'PUT', body: { archived: true } })).status, actor ? 403 : 401);
  for (const body of [{}, { archived: 'true' }, { archived: true, status: 'rejected' }]) assert.equal((await request(path, { method: 'PUT', body })).status, 400);
  assert.equal((await request('/api/admin/requests?type=vehicle&archived=invalid')).status, 400);
  assert.equal((await request(path, { method: 'PUT', body: { archived: true } })).status, 200);
  assert.equal((await Booking.findById(row._id)).status, 'pending');
  assert.equal((await request(path, { method: 'PUT', body: { archived: false } })).status, 200);
  assert.equal((await decide(row, 'reject')).status, 200);
  assert.equal((await request(path, { method: 'PUT', body: { archived: true } })).status, 200);
  assert.equal((await request(path, { method: 'PUT', body: { archived: false } })).status, 200);
  assert.equal((await Booking.findById(row._id)).status, 'rejected');
});

test('pending vehicle and visit archives only affect admin visibility and preserve all history and availability', async () => {
  for (const type of ['vehicle', 'property']) {
    const listing = await publish(type), row = await submit(listing);
    const before = await Booking.collection.findOne({ _id: new mongoose.Types.ObjectId(row._id) });
    const listingBefore = await Listing.findById(listing._id).lean();
    const paths = [['/api/bookings/mybookings', customer], ['/api/bookings/owner/requests', owner], ['/api/bookings/notifications', customer]];
    if (type === 'vehicle') paths.push(['/api/listings/' + listing._id + '/availability?from=2098-01-01&to=2098-01-31', null]);
    const responses = await Promise.all(paths.map(([path, actor]) => request(path, { actor })));
    const listPath = '/api/admin/requests?type=' + (type === 'vehicle' ? 'vehicle' : 'property_visit');
    for (const archived of [true, false]) {
      assert.equal((await request('/api/admin/requests/' + row._id + '/archive', { method: 'PUT', body: { archived } })).status, 200);
      const stored = await Booking.collection.findOne({ _id: before._id });
      assert.equal(stored.hiddenFromAdmin, archived); delete stored.hiddenFromAdmin;
      assert.deepEqual(stored, before, 'only the admin archive flag may change, including no timestamp changes');
      assert.deepEqual(await Listing.findById(listing._id).lean(), listingBefore);
      assert.deepEqual(await Promise.all(paths.map(([path, actor]) => request(path, { actor }))), responses);
      assert.equal((await request(listPath)).data.some(item => item._id === row._id), !archived);
      assert.equal((await request(listPath + '&archived=true')).data.some(item => item._id === row._id), archived);
    }
  }
});


test('archived soft hide preserves every request field, owner/customer history, notifications, interest and calendars for both sections', async () => {
  for (const type of ['vehicle', 'property']) {
    const kind = type === 'vehicle' ? 'vehicle' : 'property_visit';
    const rows = [], listings = [];
    for (const status of ['pending', 'confirmed', 'rejected', 'cancelled']) {
      const listing = await publish(type), row = await submit(listing); listings.push(listing);
      if (status === 'cancelled') assert.equal((await request('/api/bookings/' + row._id + '/cancel', { actor: customer, method: 'PUT' })).status, 200);
      else if (status !== 'pending') assert.equal((await decide(row, status === 'confirmed' ? 'confirm' : 'reject')).status, 200);
      if (type === 'property' && status === 'confirmed') assert.equal((await request('/api/preview/property-visits/' + row._id + '/decision', { actor: customer, method: 'POST', body: { decision: 'interested', confirmedInApp: true } })).status, 200);
      assert.equal((await archiveRow(row)).status, 200); rows.push(row);
    }
    const stored = await Promise.all(rows.map(row => Booking.collection.findOne({ _id: new mongoose.Types.ObjectId(row._id) })));
    const storedListings = await Listing.find({ _id: { $in: listings.map(row => row._id) } }).sort({ _id: 1 }).lean();
    const paths = [['/api/bookings/mybookings', customer], ['/api/bookings/owner/requests', owner], ['/api/bookings/notifications', customer]];
    if (type === 'vehicle') paths.push(['/api/listings/' + listings[1]._id + '/availability?from=2098-01-01&to=2098-01-31', null], ['/api/listings/' + listings[1]._id, null]);
    const set = await request('/api/admin/requests/archived-set?type=' + kind + '&search=does-not-match');
    assert.equal(set.status, 200); assert.equal(set.data.count, set.data.ids.length);
    for (const row of rows) assert.ok(set.data.ids.includes(row._id));
    // An archive created after the confirmation snapshot must never be included.
    const later = await submit(await publish(type)); assert.equal((await archiveRow(later)).status, 200);
    const before = await Promise.all(paths.map(([path, actor]) => request(path, { actor })));
    const result = await hideArchived(kind, rows.map(row => row._id));
    assert.equal(result.status, 200); assert.deepEqual(result.data.succeeded.sort(), rows.map(row => row._id).sort()); assert.deepEqual(result.data.failed, []);
    for (let i = 0; i < rows.length; i++) {
      const after = await Booking.collection.findOne({ _id: stored[i]._id });
      assert.equal(after.adminHidden, true); delete after.adminHidden; assert.deepEqual(after, stored[i]);
      assert.equal((await request('/api/admin/requests/' + rows[i]._id + '/archive', { method: 'PUT', body: { archived: false } })).status, 404, 'restore cannot resurrect admin-hidden records');
    }
    assert.deepEqual(await Listing.find({ _id: { $in: listings.map(row => row._id) } }).sort({ _id: 1 }).lean(), storedListings);
    assert.deepEqual(await Promise.all(paths.map(([path, actor]) => request(path, { actor }))), before);
    for (let refresh = 0; refresh < 2; refresh++) for (const archived of ['false', 'true']) {
      const inbox = await request('/api/admin/requests?type=' + kind + '&archived=' + archived);
      assert.ok(inbox.data.every(row => !rows.some(hidden => hidden._id === row._id)));
    }
    const refreshed = await request('/api/admin/requests/archived-set?type=' + kind);
    assert.ok(rows.every(row => !refreshed.data.ids.includes(row._id))); assert.ok(refreshed.data.ids.includes(later._id));
    assert.equal((await request('/api/admin/requests/' + later._id + '/archive', { method: 'PUT', body: { archived: false } })).status, 200);
  }
});

test('archived hide enforces admin, validated IDs, archived-only and strict request types, including legacy vehicles', async () => {
  const vehicle = await submit(await publish('vehicle')), visit = await submit(await publish('property'));
  const active = await submit(await publish('vehicle'));
  for (const row of [vehicle, visit]) assert.equal((await archiveRow(row)).status, 200);
  for (const actor of [null, customer, owner]) {
    assert.equal((await hideArchived('vehicle', [vehicle._id], actor)).status, actor ? 403 : 401);
    assert.equal((await request('/api/admin/requests/archived-set?type=vehicle', { actor })).status, actor ? 403 : 401);
  }
  for (const body of [{ type: 'vehicle', ids: ['invalid'] }, { type: 'property_booking', ids: [visit._id] }, { type: 'vehicle', ids: [] }, { type: 'vehicle', ids: [vehicle._id, vehicle._id] }, { type: 'vehicle', ids: [vehicle._id], status: 'cancelled' }]) {
    assert.equal((await request('/api/admin/requests/hide-archived', { method: 'PUT', body })).status, 400);
  }
  assert.equal((await request('/api/admin/requests/archived-set?type=all')).status, 400);
  const result = await hideArchived('vehicle', [vehicle._id, visit._id, active._id, String(new mongoose.Types.ObjectId())]);
  assert.deepEqual(result.data.succeeded, [vehicle._id]); assert.equal(result.data.failed.length, 3);
  assert.equal((await Booking.collection.findOne({ _id: new mongoose.Types.ObjectId(visit._id) })).adminHidden, undefined);
  assert.equal((await Booking.collection.findOne({ _id: new mongoose.Types.ObjectId(active._id) })).adminHidden, undefined);
  const repeat = await hideArchived('vehicle', [vehicle._id]); assert.equal(repeat.data.succeeded.length, 0); assert.equal(repeat.data.failed.length, 1);
  const legacy = await submit(await publish('vehicle')); await archiveRow(legacy);
  await Booking.collection.updateOne({ _id: new mongoose.Types.ObjectId(legacy._id) }, { $unset: { requestType: '' } });
  assert.ok((await request('/api/admin/requests/archived-set?type=vehicle')).data.ids.includes(legacy._id));
  assert.deepEqual((await hideArchived('vehicle', [legacy._id])).data.succeeded, [legacy._id]);
});

test('concurrent restore/hide and duplicate hide never expose hidden records or mutate request history', async () => {
  for (const type of ['vehicle', 'property']) {
    const row = await submit(await publish(type)), kind = type === 'vehicle' ? 'vehicle' : 'property_visit'; await archiveRow(row);
    const before = await Booking.collection.findOne({ _id: new mongoose.Types.ObjectId(row._id) });
    const [hide, restore] = await Promise.all([hideArchived(kind, [row._id]), request('/api/admin/requests/' + row._id + '/archive', { method: 'PUT', body: { archived: false } })]);
    assert.equal(hide.status, 200);
    const after = await Booking.collection.findOne({ _id: before._id });
    if (after.adminHidden) { assert.equal(after.hiddenFromAdmin, true); assert.ok([404, 409].includes(restore.status)); }
    else { assert.equal(after.hiddenFromAdmin, false); assert.equal(restore.status, 200); assert.equal(hide.data.failed.length, 1); }
    assert.deepEqual(after.createdAt, before.createdAt); assert.deepEqual(after.updatedAt, before.updatedAt); assert.equal(after.status, before.status);
    const another = await submit(await publish(type)); await archiveRow(another);
    const repeated = await Promise.all([hideArchived(kind, [another._id]), hideArchived(kind, [another._id])]);
    assert.equal(repeated.reduce((sum, result) => sum + result.data.succeeded.length, 0), 1);
  }
});

test('large archived sets are complete and bounded batch updates retain the full database records', async () => {
  const seed = await submit(await publish('vehicle'));
  const template = await Booking.collection.findOne({ _id: new mongoose.Types.ObjectId(seed._id) });
  delete template.submissionKey;
  const rows = Array.from({ length: 205 }, () => ({ ...template, _id: new mongoose.Types.ObjectId(), requestId: randomUUID(), hiddenFromAdmin: true }));
  await Booking.collection.insertMany(rows);
  const ids = rows.map(row => String(row._id));
  const prepared = await request('/api/admin/requests/archived-set?type=vehicle');
  assert.ok(ids.every(id => prepared.data.ids.includes(id)));
  assert.equal((await hideArchived('vehicle', ids)).status, 400, 'bounded payload, not an overall selection limit');
  for (let offset = 0; offset < ids.length; offset += 200) {
    const result = await hideArchived('vehicle', ids.slice(offset, offset + 200));
    assert.equal(result.status, 200); assert.equal(result.data.succeeded.length, Math.min(200, ids.length - offset)); assert.equal(result.data.failed.length, 0);
  }
  assert.equal(await Booking.countDocuments({ _id: { $in: rows.map(row => row._id) } }), 205);
  assert.equal(await Booking.countDocuments({ _id: { $in: rows.map(row => row._id) }, adminHidden: true, hiddenFromAdmin: true }), 205);
});

test('every model status supports individual archive, restore and the real bulk archive client in both sections', async () => {
  const { createServer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const { fileURLToPath } = await import('node:url');
  const client = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envDir: false,
    plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { archiveAdminRequests } = await client.ssrLoadModule('/src/components/AdminRequests.jsx');
    for (const type of ['vehicle', 'property']) {
      const kind = type === 'vehicle' ? 'vehicle' : 'property_visit';
      const rows = [], originals = [];
      for (const status of Booking.schema.path('status').enumValues) {
        const row = await submit(await publish(type));
        if (status === 'cancelled') assert.equal((await request('/api/bookings/' + row._id + '/cancel', { actor: customer, method: 'PUT' })).status, 200);
        else if (status !== 'pending') assert.equal((await decide(row, status === 'confirmed' ? 'confirm' : 'reject')).status, 200);
        const original = await Booking.collection.findOne({ _id: new mongoose.Types.ObjectId(row._id) });
        assert.equal(original.status, status);
        assert.equal((await archiveRow(row)).status, 200, type + ' individual ' + status);
        assert.equal((await request('/api/admin/requests/' + row._id + '/archive', { method: 'PUT', body: { archived: false } })).status, 200);
        const restored = await Booking.collection.findOne({ _id: original._id });
        assert.equal(restored.hiddenFromAdmin, false); delete restored.hiddenFromAdmin; assert.deepEqual(restored, original);
        rows.push(row); originals.push(original);
      }
      const result = await archiveAdminRequests({ ids: rows.map(row => row._id), token: generateToken(admin._id), isCurrent: () => true, onProgress() {}, send: (path, options) => fetch(origin + path, options) });
      assert.deepEqual(result.failed, []); assert.deepEqual(result.succeeded, rows.map(row => row._id));
      const archived = await request('/api/admin/requests?type=' + kind + '&archived=true');
      assert.ok(rows.every(row => archived.data.some(item => item._id === row._id)));
      assert.equal((await hideArchived(kind, rows.map(row => row._id))).data.succeeded.length, rows.length);
      for (const original of originals) {
        const hidden = await Booking.collection.findOne({ _id: original._id });
        assert.equal(hidden.adminHidden, true); assert.equal(hidden.hiddenFromAdmin, true);
        delete hidden.adminHidden; delete hidden.hiddenFromAdmin; assert.deepEqual(hidden, original);
      }
      const fresh = await submit(await publish(type));
      assert.ok((await request('/api/admin/requests?type=' + kind)).data.some(row => row._id === fresh._id && row.status === 'pending'));
    }
  } finally { await client.close(); }
});

test('archive still rejects corrupt statuses without modifying the original request', async () => {
  const row = await submit(await publish('property'));
  await Booking.collection.updateOne({ _id: new mongoose.Types.ObjectId(row._id) }, { $set: { status: 'invalid-test-status' } });
  const before = await Booking.collection.findOne({ _id: new mongoose.Types.ObjectId(row._id) });
  const result = await archiveRow(row);
  assert.equal(result.status, 409); assert.match(result.data.message, /invalid status/);
  assert.deepEqual(await Booking.collection.findOne({ _id: before._id }), before);
});
