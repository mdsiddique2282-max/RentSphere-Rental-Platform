import { configureDeliveryQuotes } from './helpers/deliveryQuoteFixture.js';
import { hostingFixture } from './helpers/hostingFixture.js';
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
import auth from '../routes/auth.js';
import saved from '../routes/saved.js';
import listings from '../routes/listings.js';
import bookings from '../routes/bookings.js';
import adminRoutes from '../routes/admin.js';
import { generateToken } from '../utils/tokens.js';
import { historyGroup, requestStatus } from '../../src/data/requestHistory.js';
import { stagingInterestWorkflow } from '../utils/stagingParity.js';
import { createPasswordResetRouter, resetResponse } from '../routes/passwordReset.js';
import PasswordReset from '../models/PasswordReset.js';
import ResetThrottle from '../models/ResetThrottle.js';
import bcrypt from 'bcryptjs';
import { resetEmailConfig } from '../utils/resetEmail.js';
import { canRecordPropertyInterest } from '../../src/data/propertyVisitAccess.js';
import { withVehicleBookingStatus } from '../utils/vehicleBookings.js';

process.env.JWT_SECRET = randomBytes(48).toString('hex');
let mongo, server, origin, customer, stranger, owner, otherOwner, admin;
const emails = [];
const smtpFixture = { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'smtp-fixture@example.test', SMTP_PASS: 'mock-only-app-password', EMAIL_FROM: 'sender@example.test', APP_BASE_URL: 'http://localhost:5173' };
let failDelivery = false, deliveryGate;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: join(tmpdir(), 'rentsphere-test-mongodb') }, replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { dbName: 'phase3_disposable_' + randomUUID().replaceAll('-', '') });
  afterConnectionName = mongoose.connection.name;
  await Promise.all([User.init(), Listing.init(), Booking.init()]);
  [customer, stranger, owner, otherOwner, admin] = await Promise.all(['user', 'user', 'owner', 'owner', 'admin'].map(role => User.create({
    name: 'Isolated phase3 test', email: randomUUID() + '@example.test', password: 'ChosenTestPassword!', role,
    ...(role === 'owner' ? { ownerProfile: { status: 'approved', listingIntent: 'both' } } : {}),
  })));
  const app = express(); configureDeliveryQuotes(app); app.use(express.json());
  for (const [name, router] of Object.entries({ auth, saved, listings, bookings, admin: adminRoutes })) app.use('/api/' + name, router);
  app.use('/api/auth', createPasswordResetRouter({ env: smtpFixture, mailer: () => ({ sendMail: async message => { if (failDelivery) throw new Error('Mock SMTP failure'); if (deliveryGate) { deliveryGate.started(); await deliveryGate.wait; } emails.push(message); return { accepted: [message.to], rejected: [] }; } }) }));
  app.use('/api/unconfigured-auth', createPasswordResetRouter({ env: {} }));
  app.use('/api/preview', stagingInterestWorkflow);
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  origin = 'http://127.0.0.1:' + server.address().port;
}, { timeout: 180000 });
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo?.stop(); });
async function request(path, { actor = customer, method = 'GET', body } = {}) {
  const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: 'Bearer ' + generateToken(actor._id) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
const listing = (type = 'vehicle', host = owner) => Listing.create({ title: 'Isolated phase3 listing', type, location: 'Mumbai', price: 900, host: host._id });
const dates = row => ({ listingId: String(row._id), startDate: '2091-03-01', endDate: '2091-03-03' });

test('saved listings are authenticated, per-account, idempotent and persist across reconnect without changing other user fields', async () => {
  const row = await listing(); const before = await User.findById(customer._id).lean();
  assert.equal((await request('/api/saved', { actor: null })).status, 401);
  for (let i = 0; i < 2; i++) assert.equal((await request('/api/saved/' + row._id, { method: 'PUT' })).status, 200);
  assert.equal((await request('/api/saved')).data.length, 1);
  assert.equal((await request('/api/saved', { actor: stranger })).data.length, 0);
  const after = await User.findById(customer._id).select('+savedListings').lean();
  assert.equal(after.savedListings.length, 1); assert.equal(after.password, before.password); assert.equal(after.role, before.role);
  await mongoose.disconnect(); await mongoose.connect(mongo.getUri(), { dbName: afterConnectionName });
  assert.equal((await request('/api/saved')).data[0]._id, String(row._id));
  assert.equal((await request('/api/saved/' + row._id, { method: 'DELETE' })).status, 200);
  assert.equal((await request('/api/saved')).data.length, 0);
});
let afterConnectionName;
test('saved dashboard data includes unavailable properties and vehicles, omits missing listings and preserves unsave', async () => {
  const property = await listing('property'), vehicle = await listing('vehicle');
  await Listing.updateOne({ _id: property._id }, { $set: { available: false, availability: 'Unavailable' } });
  for (const row of [property, vehicle]) assert.equal((await request('/api/saved/' + row._id, { method: 'PUT' })).status, 200);
  const rows = (await request('/api/saved')).data;
  assert.ok(rows.some(row => row._id === String(property._id) && row.available === false));
  assert.ok(rows.some(row => row._id === String(vehicle._id) && row.type === 'vehicle' && row.vehicleBookingStatus === 'available'));
  await Listing.deleteOne({ _id: vehicle._id }); // Disposable fixture only.
  assert.ok(!(await request('/api/saved')).data.some(row => row._id === String(vehicle._id)));
  assert.equal((await request('/api/saved/' + vehicle._id, { method: 'DELETE' })).status, 200);
  assert.equal((await request('/api/saved/' + property._id, { method: 'DELETE' })).status, 200);
  assert.ok(!(await request('/api/saved')).data.some(row => row._id === String(property._id)));
});

test('owner mine distinguishes successful arrays from query failures without changing authorization', async t => {
  assert.equal((await request('/api/listings/mine', { actor: null })).status, 401);
  const actor = await User.create({ name: 'Disposable inbox owner', email: randomUUID() + '@example.test', password: 'ChosenTestPassword!', role: 'owner', ownerProfile: { status: 'approved', listingIntent: 'both' } });
  assert.deepEqual((await request('/api/listings/mine', { actor })).data, []);
  const row = await listing('property', actor);
  const success = await request('/api/listings/mine', { actor });
  assert.equal(success.status, 200); assert.equal(success.data[0]._id, String(row._id));
  const failure = t.mock.method(Listing, 'find', () => { throw new Error('Disposable query failure'); });
  try {
    const response = await request('/api/listings/mine', { actor });
    assert.equal(response.status, 503); assert.deepEqual(response.data, { message: 'Unable to load your listings. Please try again.' });
  } finally { failure.mock.restore(); }
  assert.equal((await request('/api/listings/mine', { actor })).data[0]._id, String(row._id));
});

test('customer history and cancellation are private, persisted and reject terminal-state changes', async () => {
  const row = await listing();
  const created = await request('/api/bookings', { method: 'POST', body: dates(row) });
  assert.equal(created.status, 201);
  assert.equal((await request('/api/bookings/' + created.data._id + '/cancel', { actor: stranger, method: 'PUT' })).status, 403);
  assert.equal((await request('/api/bookings/mybookings', { actor: stranger })).data.length, 0);
  assert.equal((await request('/api/bookings/' + created.data._id + '/cancel', { method: 'PUT' })).status, 200);
  assert.equal((await request('/api/bookings/' + created.data._id + '/cancel', { method: 'PUT' })).status, 409);
  assert.equal((await request('/api/bookings/mybookings')).data.find(row => row._id === created.data._id).status, 'cancelled');
  assert.equal(historyGroup({ status: 'confirmed', endDate: '2020-01-01' }, '2026-10-20'), 'Past / completed');
  assert.equal(requestStatus({ status: 'confirmed', requestType: 'vehicle', endDate: '2020-01-01' }, '2026-10-20'), 'Completed');
});

test('approved owners add/edit only their own listings; manual availability blocks new requests and preserves existing bookings', async () => {
  const created = await request('/api/listings', { actor: owner, method: 'POST', body: { ...hostingFixture('vehicle'), type: 'vehicle', title: 'Owner-created vehicle', location: 'Mumbai', price: 800 } });
  assert.equal(created.status, 201); const id = created.data._id;
  assert.equal((await request('/api/listings/' + id, { actor: otherOwner, method: 'PUT', body: { price: 20 } })).status, 403);
  assert.equal((await request('/api/listings/' + id, { actor: owner, method: 'PUT', body: { price: 950, description: 'Edited by owner' } })).status, 200);
  const row = await Listing.findById(id);
  const pending = await request('/api/bookings', { method: 'POST', body: dates(row) }); assert.equal(pending.status, 201);
  const path = '/api/listings/' + id + '/availability';
  assert.equal((await request(path, { actor: customer, method: 'PUT', body: { available: false } })).status, 403);
  assert.equal((await request(path, { actor: otherOwner, method: 'PUT', body: { available: false } })).status, 403);
  assert.equal((await request(path, { actor: owner, method: 'PUT', body: { available: false } })).status, 200);
  assert.equal((await request('/api/bookings', { actor: stranger, method: 'POST', body: dates(row) })).status, 409);
  assert.equal((await Booking.findById(pending.data._id)).status, 'pending');
  assert.equal((await request(path, { actor: admin, method: 'PUT', body: { available: true } })).status, 200);
  assert.equal((await request('/api/bookings/' + pending.data._id + '/confirm', { actor: owner, method: 'PUT' })).status, 200);
  assert.equal((await request('/api/listings/' + id, { actor: otherOwner, method: 'DELETE' })).status, 403);
  assert.equal((await request('/api/listings/' + id, { actor: owner, method: 'DELETE' })).status, 200);
  assert.ok((await Listing.findById(id)).archivedAt); assert.ok(await Booking.findById(pending.data._id));
});

test('vehicle reject releases dates; confirmations serialize inclusive overlaps and calendar exposes no customer data', async () => {
  const row = await listing();
  const first = await request('/api/bookings', { method: 'POST', body: dates(row) });
  const second = await request('/api/bookings', { actor: stranger, method: 'POST', body: { ...dates(row), startDate: '2091-03-03', endDate: '2091-03-04' } });
  assert.equal((await request('/api/bookings/' + first.data._id + '/reject', { actor: otherOwner, method: 'PUT' })).status, 403);
  assert.equal((await request('/api/bookings/' + first.data._id + '/reject', { actor: owner, method: 'PUT' })).status, 200);
  assert.equal((await request('/api/bookings/' + first.data._id + '/confirm', { actor: owner, method: 'PUT' })).status, 409);
  assert.equal((await request('/api/bookings/' + second.data._id + '/confirm', { actor: owner, method: 'PUT' })).status, 200);
  const base = '/api/listings/' + row._id + '/availability';
  const calendar = await request(base + '?from=2091-03-01&to=2091-03-31', { actor: null });
  assert.equal(calendar.status, 200); assert.equal(calendar.data.bookedRanges.length, 1);
  assert.deepEqual(Object.keys(calendar.data.bookedRanges[0]).sort(), ['endDate', 'startDate']);
  assert.equal((await request('/api/bookings', { method: 'POST', body: { ...dates(row), startDate: '2091-03-04', endDate: '2091-03-05' } })).status, 409);
  assert.equal((await request(base + '?from=2091-02-30&to=2091-03-01')).status, 400);
  assert.equal((await request(base + '?from=2091-04-01&to=2091-04-30')).data.bookedRanges.length, 0);
  assert.equal((await request('/api/bookings/' + second.data._id + '/cancel', { actor: stranger, method: 'PUT' })).status, 200);
  assert.equal((await request(base + '?from=2091-03-01&to=2091-03-31')).data.bookedRanges.length, 0);
});

test('vehicle status is derived from confirmed bookings, respects manual control and expires at India midnight without rewriting records', async () => {
  const created = await request('/api/listings', { actor: owner, method: 'POST', body: hostingFixture('vehicle') });
  assert.equal(created.status, 201);
  const id = created.data._id;
  const summary = async () => (await request('/api/listings/' + id, { actor: null })).data.vehicleBookingStatus;
  const submit = (start, end) => request('/api/bookings', { method: 'POST', body: { listingId: id, startDate: start, endDate: end, fulfilment: 'pickup' } });
  assert.equal(await summary(), 'available');
  const rejected = await submit('2097-01-01', '2097-01-03');
  assert.equal(rejected.status, 201); assert.equal(await summary(), 'available');
  assert.equal((await request('/api/bookings/' + rejected.data._id + '/reject', { actor: owner, method: 'PUT' })).status, 200);
  assert.equal(await summary(), 'available');
  const booking = await submit('2097-01-10', '2097-01-12');
  assert.equal(booking.status, 201);
  assert.equal((await request('/api/bookings/' + booking.data._id + '/confirm', { actor: owner, method: 'PUT' })).status, 200);
  assert.equal(await summary(), 'partially-booked');
  const publicRows = await request('/api/listings?type=vehicle', { actor: null });
  assert.equal(publicRows.data.find(row => row._id === id).vehicleBookingStatus, 'partially-booked');
  const calendarPath = '/api/listings/' + id + '/availability?from=2097-01-01&to=2097-01-31';
  const calendar = await request(calendarPath, { actor: null });
  assert.equal(calendar.data.vehicleBookingStatus, 'partially-booked'); assert.equal(calendar.data.available, true);
  assert.equal(calendar.data.bookedRanges.length, 1);
  const unrelatedMonth = await request('/api/listings/' + id + '/availability?from=2097-02-01&to=2097-02-28', { actor: null });
  assert.equal(unrelatedMonth.data.vehicleBookingStatus, 'partially-booked'); assert.equal(unrelatedMonth.data.bookedRanges.length, 0);
  assert.equal((await request(calendarPath, { actor: owner })).data.vehicleBookingStatus, 'partially-booked');
  const other = await listing();
  assert.equal((await request('/api/listings/' + other._id, { actor: null })).data.vehicleBookingStatus, 'available');
  assert.equal((await request('/api/listings/' + id + '/availability', { actor: owner, method: 'PUT', body: { available: false } })).status, 200);
  assert.equal(await summary(), 'unavailable');
  assert.equal((await request(calendarPath, { actor: null })).data.vehicleBookingStatus, 'unavailable');
  assert.equal((await request('/api/listings/' + id + '/availability', { actor: owner, method: 'PUT', body: { available: true } })).status, 200);
  assert.equal(await summary(), 'partially-booked');
  const beforeListing = await Listing.findById(id).lean(), beforeBooking = await Booking.findById(booking.data._id).lean();
  assert.equal((await withVehicleBookingStatus(beforeListing, new Date('2097-01-12T18:29:59Z'))).vehicleBookingStatus, 'partially-booked');
  assert.equal((await withVehicleBookingStatus(beforeListing, new Date('2097-01-12T18:30:00Z'))).vehicleBookingStatus, 'available');
  const batched = await withVehicleBookingStatus([beforeListing, other.toObject()], new Date('2097-01-12T18:29:59Z'));
  assert.deepEqual(batched.map(row => row.vehicleBookingStatus), ['partially-booked', 'available']);
  assert.deepEqual(await Listing.findById(id).lean(), beforeListing);
  assert.deepEqual(await Booking.findById(booking.data._id).lean(), beforeBooking);
});

test('real vehicle requests block only confirmed inclusive dates, persist across reconnect, and retain manual availability and history', async () => {
  const uploaded = await request('/api/listings', { actor: owner, method: 'POST', body: hostingFixture('vehicle') });
  assert.equal(uploaded.status, 201);
  const id = uploaded.data._id;
  const base = '/api/listings/' + id + '/availability';
  const calendar = actor => request(base + '?from=2097-01-01&to=2097-01-31', { actor });
  const submit = (startDate, endDate, actor = customer) => request('/api/bookings', { actor, method: 'POST', body: { listingId: id, startDate, endDate, fulfilment: 'pickup' } });
  const first = await submit('2097-01-10', '2097-01-12');
  const overlap = await submit('2097-01-12', '2097-01-14', stranger);
  const rejected = await submit('2097-01-16', '2097-01-17');
  for (const result of [first, overlap, rejected]) { assert.equal(result.status, 201); assert.equal(result.data.status, 'pending'); }
  assert.equal((await calendar(null)).data.bookedRanges.length, 0);
  const accepted = await request('/api/bookings/' + first.data._id + '/confirm', { actor: owner, method: 'PUT' });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.status, 'confirmed');
  assert.equal(accepted.data.ownerDecision.status, 'confirmed');
  const publicCalendar = await calendar(null), ownerCalendar = await calendar(owner);
  assert.equal(publicCalendar.data.available, true);
  assert.deepEqual(publicCalendar.data.bookedRanges, ownerCalendar.data.bookedRanges);
  assert.deepEqual(publicCalendar.data.bookedRanges, [{ startDate: '2097-01-10T00:00:00.000Z', endDate: '2097-01-12T00:00:00.000Z' }]);
  for (const [start, end] of [['2097-01-09', '2097-01-10'], ['2097-01-12', '2097-01-13'], ['2097-01-11', '2097-01-11']]) assert.equal((await submit(start, end)).status, 409);
  assert.equal((await request('/api/bookings/' + overlap.data._id + '/confirm', { actor: owner, method: 'PUT' })).status, 409);
  assert.equal((await Booking.findById(overlap.data._id)).status, 'pending');
  assert.equal((await request('/api/bookings/' + rejected.data._id + '/reject', { actor: owner, method: 'PUT' })).status, 200);
  assert.equal((await submit('2097-01-13', '2097-01-15')).status, 201);
  assert.equal((await submit('2097-01-16', '2097-01-17', stranger)).status, 201);
  const otherVehicle = await listing();
  assert.equal((await request('/api/listings/' + otherVehicle._id + '/availability?from=2097-01-01&to=2097-01-31', { actor: null })).data.bookedRanges.length, 0);
  const competing = await Promise.all([customer, stranger].map(actor => request('/api/bookings', { actor, method: 'POST', body: {
    listingId: String(otherVehicle._id), startDate: '2097-02-01', endDate: '2097-02-03', fulfilment: 'pickup' } })));
  const decisions = await Promise.all(competing.map(row => request('/api/bookings/' + row.data._id + '/confirm', { actor: owner, method: 'PUT' })));
  assert.deepEqual(decisions.map(row => row.status).sort(), [200, 409]);
  assert.equal(await Booking.countDocuments({ listing: otherVehicle._id, status: 'confirmed' }), 1);
  assert.equal(await Booking.countDocuments({ listing: otherVehicle._id, status: 'pending' }), 1);
  const dbName = mongoose.connection.name;
  await mongoose.disconnect(); await mongoose.connect(mongo.getUri(), { dbName });
  assert.deepEqual((await calendar(null)).data.bookedRanges, publicCalendar.data.bookedRanges);
  const manual = await request(base, { actor: owner, method: 'PUT', body: { available: false } });
  assert.equal(manual.status, 200);
  assert.equal((await calendar(null)).data.available, false);
  assert.equal((await submit('2097-01-25', '2097-01-26')).status, 409);
  assert.equal((await Booking.findById(first.data._id)).status, 'confirmed');
  assert.equal((await request(base, { actor: owner, method: 'PUT', body: { available: true } })).status, 200);
  assert.deepEqual((await calendar(null)).data.bookedRanges, publicCalendar.data.bookedRanges);
  const historical = await Booking.create({ listing: id, user: customer._id, requestType: 'vehicle', status: 'confirmed',
    startDate: new Date('2000-01-01'), endDate: new Date('2000-01-03'), totalPrice: 2400 });
  assert.equal((await request(base + '?from=2097-02-01&to=2097-02-28', { actor: null })).data.bookedRanges.length, 0);
  assert.equal((await Booking.findById(historical._id)).status, 'confirmed');
  assert.equal((await Listing.findById(id)).available, true);
  assert.equal((await submit('2097-02-05', '2097-02-06')).status, 201);
});

test('visit acceptance and customer interest remain separate from renting; manual property unavailability blocks new visits', async () => {
  const row = await listing('property');
  const visit = await request('/api/bookings/visits', { method: 'POST', body: { listingId: String(row._id), startDate: '2091-04-01' } });
  assert.equal(visit.status, 201);
  assert.equal((await request('/api/bookings/' + visit.data._id + '/confirm', { actor: owner, method: 'PUT' })).status, 200);
  assert.equal((await Listing.findById(row._id)).status, 'available');
  const path = '/api/preview/property-visits/' + visit.data._id + '/decision';
  assert.equal((await request(path, { actor: stranger, method: 'POST', body: { decision: 'interested', confirmedInApp: true } })).status, 404);
  const decision = await request(path, { method: 'POST', body: { decision: 'interested', confirmedInApp: true } });
  assert.equal(decision.status, 200); assert.equal(decision.data.propertyStatus, 'available');
  assert.equal(decision.data.propertyAvailable, false);
  assert.equal(decision.data.propertyAvailability, 'Unavailable');
  assert.equal((await Listing.findById(row._id)).available, false);
  assert.equal((await Listing.findById(row._id)).status, 'available');
  assert.equal((await request('/api/listings/' + row._id + '/availability', { actor: owner, method: 'PUT', body: { available: false } })).status, 200);
  assert.equal((await request('/api/bookings/visits', { actor: stranger, method: 'POST', body: { listingId: String(row._id), startDate: '2091-04-02' } })).status, 409);
  const inbox = await request('/api/bookings/owner/requests', { actor: owner });
  assert.equal(inbox.status, 200); assert.ok(inbox.data.some(item => item._id === visit.data._id && item.propertyDecision?.kind === 'interested'));
  const persistedVisit = await Booking.findById(visit.data._id).lean();
  const ownerVisit = inbox.data.find(item => item._id === visit.data._id);
  assert.equal(ownerVisit.createdAt, persistedVisit.createdAt.toISOString());
  assert.equal(ownerVisit.listing.location, row.location);
  const predefined = await listing('property', admin);
  const predefinedVisit = await request('/api/bookings/visits', { method: 'POST', body: { listingId: String(predefined._id), startDate: '2091-04-01' } });
  assert.equal(predefinedVisit.status, 201);
  assert.ok(!(await request('/api/bookings/owner/requests', { actor: owner })).data.some(item => item._id === predefinedVisit.data._id));
  assert.ok((await request('/api/admin/requests?type=property_visit', { actor: admin })).data.some(item => item._id === predefinedVisit.data._id));
  assert.equal((await request('/api/bookings/owner/requests', { actor: customer })).status, 403);
  assert.ok((await request('/api/bookings/owner/requests', { actor: otherOwner })).data.every(item => String(item.listing.host) === String(otherOwner._id)));
});

const decisionPath = visit => '/api/preview/property-visits/' + visit._id + '/decision';
const recordDecision = (visit, decision, actor = customer) => request(decisionPath(visit),
  { actor, method: 'POST', body: { decision, confirmedInApp: true } });
async function decisionFixture(actors = [customer], listingFields = {}) {
  const row = await listing('property');
  if (Object.keys(listingFields).length) await Listing.updateOne({ _id: row._id }, { $set: listingFields });
  const visits = await Promise.all(actors.map(actor => Booking.create({ listing: row._id, user: actor._id,
    requestType: 'property_visit', status: 'confirmed', startDate: new Date('2091-05-01'), endDate: new Date('2091-05-01'), totalPrice: 0 })));
  return { row, visits };
}

test('real owner upload -> customer visit -> owner Accept -> customer access -> interest save uses one persisted visit end to end', async () => {
  const login = await request('/api/auth/login', { actor: null, method: 'POST', body: { email: owner.email, password: 'ChosenTestPassword!' } });
  assert.equal(login.status, 200);
  const registered = await request('/api/auth/register', { actor: null, method: 'POST', body: {
    name: 'End-to-end disposable customer', email: randomUUID() + '@example.test', password: 'CustomerChosenPassword!' } });
  assert.equal(registered.status, 201);
  const customerLogin = await request('/api/auth/login', { actor: null, method: 'POST', body: { email: registered.data.email, password: 'CustomerChosenPassword!' } });
  assert.equal(customerLogin.status, 200);
  const ownerToken = login.data.token, customerToken = customerLogin.data.token;
  const api = async (path, token, method = 'GET', body) => {
    const response = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.match(response.headers.get('content-type'), /application\/json/);
    return { status: response.status, data: await response.json() };
  };
  for (const decision of ['interested', 'not-interested', 'rejected']) {
    const uploaded = await api('/api/listings', ownerToken, 'POST', hostingFixture('property'));
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.data.hostingDetailsVersion, 1);
    const listingId = uploaded.data._id;
    const submitted = await api('/api/bookings/visits', customerToken, 'POST', { listingId, startDate: '2091-07-01',
      contact: { name: 'Customer', email: customerLogin.data.email, phone: '9876543210' } });
    assert.equal(submitted.status, 201); assert.equal(submitted.data.status, 'pending');
    assert.equal(submitted.data.user, customerLogin.data._id); assert.equal(submitted.data.listing, listingId);
    const path = '/api/preview/property-visits/' + listingId;
    const allowed = data => canRecordPropertyInterest(data && { ...data, token: customerToken, listingId }, customerToken, listingId);
    const pending = await api(path, customerToken);
    assert.equal(pending.data.requestId, submitted.data._id); assert.equal(allowed(pending.data), false);
    const inbox = await api('/api/bookings/owner/requests', ownerToken);
    assert.ok(inbox.data.some(row => row._id === submitted.data._id && row.listing._id === listingId && row.user._id === customerLogin.data._id));
    const accepted = await api('/api/bookings/' + submitted.data._id + (decision === 'rejected' ? '/reject' : '/confirm'), ownerToken, 'PUT');
    assert.equal(accepted.status, 200);
    const access = await api(path, customerToken);
    assert.equal(access.data.requestId, submitted.data._id);
    assert.equal(access.data.status, decision === 'rejected' ? 'rejected' : 'confirmed');
    assert.equal((await Booking.findById(submitted.data._id)).status, access.data.status);
    assert.equal(allowed(access.data), decision !== 'rejected');
    assert.equal(allowed((await api(path, ownerToken)).data), false);
    assert.equal((await api(path, customerToken)).data.status, access.data.status, 'refresh reads the same accepted visit');
    assert.equal(canRecordPropertyInterest({ ...access.data, token: customerToken, listingId }, ownerToken, listingId), false);
    if (decision === 'rejected') continue;
    if (decision === 'not-interested') assert.equal((await api('/api/listings/' + listingId + '/availability', ownerToken, 'PUT', { available: false })).status, 200);
    const saved = await api('/api/preview/property-visits/' + access.data.requestId + '/decision', customerToken, 'POST', { decision, confirmedInApp: true });
    assert.equal(saved.status, 200); assert.equal(saved.data.propertyAvailable, false);
    const property = (await api('/api/listings/' + listingId, customerToken)).data;
    assert.equal(property.available, false); assert.equal(property.availability, 'Unavailable'); assert.notEqual(property.status, 'rented');
    assert.equal(allowed((await api(path, customerToken)).data), false);
  }
});

test('property visit visibility is server-verified: pending/rejected hidden, accepted customer only, multiple requests retain accepted access', async () => {
  const { row, visits: [visit] } = await decisionFixture();
  const path = '/api/preview/property-visits/' + row._id;
  await Booking.updateOne({ _id: visit._id }, { $set: { status: 'pending' } });
  let result = await request(path);
  assert.equal(result.data.status, 'pending'); assert.equal(result.data.actionable, false);
  assert.equal((await recordDecision(visit, 'interested')).status, 409);
  assert.equal((await request('/api/bookings/' + visit._id + '/reject', { actor: owner, method: 'PUT' })).status, 200);
  result = await request(path);
  assert.equal(result.data.status, 'rejected'); assert.equal(result.data.actionable, false);
  const submitted = await request('/api/bookings/visits', { method: 'POST', body: { listingId: String(row._id), startDate: '2091-06-05' } });
  assert.equal(submitted.status, 201); assert.equal(submitted.data.status, 'pending');
  assert.equal((await request(path)).data.actionable, false);
  assert.equal((await request('/api/bookings/' + submitted.data._id + '/confirm', { actor: owner, method: 'PUT' })).status, 200);
  result = await request(path);
  assert.equal(result.data.status, 'confirmed'); assert.equal(result.data.actionable, true);
  assert.equal(result.data.requestId, submitted.data._id);
  assert.equal((await request(path, { actor: stranger })).data, null);
  assert.equal((await request(path, { actor: null })).status, 401);
  assert.equal((await request('/api/preview/property-visits/' + new mongoose.Types.ObjectId())).data, null);
  const newer = await Booking.create({ listing: row._id, user: customer._id, requestType: 'property_visit', status: 'pending',
    startDate: new Date('2091-06-10'), endDate: new Date('2091-06-10'), totalPrice: 0 });
  assert.equal((await request(path)).data.requestId, submitted.data._id);
  await Booking.updateOne({ _id: newer._id }, { $set: { status: 'rejected' } });
  assert.equal((await request(path)).data.requestId, submitted.data._id);
  assert.equal((await recordDecision({ _id: submitted.data._id }, 'interested')).status, 200);
  assert.equal((await request(path)).data.actionable, false);
  assert.equal((await Listing.findById(row._id)).available, false);
});

test('Not Interested leaves an unrestricted property available; manual and legacy unavailability are preserved', async () => {
  for (const fields of [{}, { available: false, availability: 'Unavailable' }, { status: 'rented', availability: 'Currently Rented' }]) {
    const { row, visits: [visit] } = await decisionFixture([customer], fields);
    const before = await Listing.findById(row._id).lean();
    assert.equal((await recordDecision(visit, 'not-interested')).status, 200);
    const after = await Listing.findById(row._id).lean();
    for (const field of ['status', 'available', 'availability']) assert.equal(after[field], before[field]);
    assert.equal((await Booking.findById(visit._id)).propertyDecision.kind, 'not-interested');
  }
});

test('different customer decisions serialize; Not Interested preserves a hold but explicit owner Make Available clears it', async () => {
  const { row, visits } = await decisionFixture([customer, stranger]);
  const results = await Promise.all([recordDecision(visits[0], 'interested'), recordDecision(visits[1], 'not-interested', stranger)]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal((await Listing.findById(row._id)).available, false);
  const publicRow = await request('/api/listings/' + row._id, { actor: null });
  assert.equal(publicRow.data.availability, 'Unavailable');
  assert.equal((await request('/api/admin/listings', { actor: admin })).data.find(item => item._id === String(row._id)).available, false);
  assert.equal((await request('/api/listings/mine', { actor: owner })).data.find(item => item._id === String(row._id)).available, false);
  assert.equal((await request('/api/bookings/visits', { method: 'POST', body: { listingId: String(row._id), startDate: '2091-06-01' } })).status, 409);
  const before = await Booking.find({ listing: row._id }).sort({ _id: 1 }).lean();
  const available = await request('/api/listings/' + row._id + '/availability', { actor: owner, method: 'PUT', body: { available: true } });
  assert.equal(available.status, 200); assert.equal(available.data.available, true);
  assert.equal((await request('/api/listings/' + row._id, { actor: null })).data.availability, 'Available now');
  assert.equal((await request('/api/listings/mine', { actor: owner })).data.find(item => item._id === String(row._id)).available, true);
  assert.equal((await recordDecision(visits[0], 'interested')).status, 200);
  assert.equal((await recordDecision(visits[1], 'not-interested', stranger)).status, 200);
  assert.equal((await Listing.findById(row._id)).available, true, 'retries must not reapply an explicitly cleared hold');
  assert.deepEqual(await Booking.find({ listing: row._id }).sort({ _id: 1 }).lean(), before);
});

test('owner Make Available persists across reconnect without changing visits; a new Interested decision still applies a new hold', async () => {
  const uploaded = await request('/api/listings', { actor: owner, method: 'POST', body: hostingFixture('property') });
  assert.equal(uploaded.status, 201);
  const id = uploaded.data._id;
  const submitted = await request('/api/bookings/visits', { method: 'POST', body: { listingId: id, startDate: '2091-08-01' } });
  assert.equal(submitted.status, 201);
  assert.equal((await request('/api/bookings/' + submitted.data._id + '/confirm', { actor: owner, method: 'PUT' })).status, 200);
  assert.equal((await recordDecision({ _id: submitted.data._id }, 'interested')).status, 200);
  assert.equal((await Listing.findById(id)).available, false);
  const before = await Booking.findById(submitted.data._id).lean();
  const path = '/api/listings/' + id + '/availability';
  assert.equal((await request(path, { actor: stranger, method: 'PUT', body: { available: true } })).status, 403);
  assert.equal((await request(path, { actor: owner, method: 'PUT', body: { available: true } })).status, 200);
  const dbName = mongoose.connection.name;
  await mongoose.disconnect(); await mongoose.connect(mongo.getUri(), { dbName });
  assert.equal((await request('/api/listings/' + id, { actor: null })).data.available, true);
  assert.equal((await request('/api/listings?type=property', { actor: null })).data.find(row => row._id === id).available, true);
  assert.equal((await request('/api/listings/mine', { actor: owner })).data.find(row => row._id === id).available, true);
  assert.deepEqual(await Booking.findById(submitted.data._id).lean(), before);
  const retried = await Promise.all([recordDecision({ _id: submitted.data._id }, 'interested'),
    request(path, { actor: owner, method: 'PUT', body: { available: true } })]);
  assert.deepEqual(retried.map(result => result.status), [200, 200]);
  assert.equal((await Listing.findById(id)).available, true);
  const next = await request('/api/bookings/visits', { actor: stranger, method: 'POST', body: { listingId: id, startDate: '2091-08-02' } });
  assert.equal(next.status, 201);
  assert.equal((await request('/api/bookings/' + next.data._id + '/confirm', { actor: owner, method: 'PUT' })).status, 200);
  assert.equal((await recordDecision({ _id: next.data._id }, 'interested', stranger)).status, 200);
  assert.equal((await Listing.findById(id)).available, false);
  assert.deepEqual(await Booking.findById(submitted.data._id).lean(), before);
});

test('decision retries are idempotent and simultaneous opposite decisions never overwrite each other', async () => {
  const { row, visits: [visit] } = await decisionFixture();
  assert.deepEqual((await Promise.all([recordDecision(visit, 'interested'), recordDecision(visit, 'interested')])).map(result => result.status), [200, 200]);
  const recordedAt = (await Booking.findById(visit._id)).propertyDecision.recordedAt;
  assert.equal((await recordDecision(visit, 'interested')).status, 200);
  assert.deepEqual((await Booking.findById(visit._id)).propertyDecision.recordedAt, recordedAt);
  assert.equal((await recordDecision(visit, 'not-interested')).status, 409);
  assert.equal((await Listing.findById(row._id)).available, false);
  const other = await decisionFixture();
  const results = await Promise.all([recordDecision(other.visits[0], 'interested'), recordDecision(other.visits[0], 'not-interested')]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const saved = await Booking.findById(other.visits[0]._id);
  assert.equal((await Listing.findById(other.row._id)).available === false, saved.propertyDecision.kind === 'interested');
});

test('only the associated authenticated customer of a confirmed visit can record a decision', async () => {
  const { row, visits: [visit] } = await decisionFixture();
  for (const actor of [null, stranger, owner, admin]) assert.equal((await recordDecision(visit, 'interested', actor)).status, actor ? 404 : 401);
  for (const status of ['pending', 'rejected', 'cancelled']) {
    await Booking.updateOne({ _id: visit._id }, { $set: { status } });
    assert.equal((await recordDecision(visit, 'interested')).status, 409);
    assert.equal((await request('/api/preview/property-visits/' + row._id)).data.actionable, false);
  }
  assert.equal((await Booking.findById(visit._id)).propertyDecision, undefined);
  assert.notEqual((await Listing.findById(row._id)).available, false);
});

test('transaction failure after both writes rolls back interest and availability together', async () => {
  const { row, visits: [visit] } = await decisionFixture();
  const client = mongoose.connection.getClient(), originalStart = client.startSession;
  client.startSession = function (...args) {
    const session = originalStart.apply(this, args), transaction = session.withTransaction.bind(session);
    session.withTransaction = callback => transaction(async () => { await callback(); throw new Error('Injected pre-commit failure'); });
    return session;
  };
  try { assert.equal((await recordDecision(visit, 'interested')).status, 503); }
  finally { client.startSession = originalStart; }
  assert.equal((await Booking.findById(visit._id)).propertyDecision, undefined);
  assert.notEqual((await Listing.findById(row._id)).available, false);
  assert.equal((await recordDecision(visit, 'interested')).status, 200);
});

test('cancellation releases only the last automatic interest hold and never a manual owner restriction', async () => {
  for (const manual of [false, true]) {
    const { row, visits } = await decisionFixture([customer, stranger]);
    assert.equal((await recordDecision(visits[0], 'interested')).status, 200);
    assert.equal((await recordDecision(visits[1], 'interested', stranger)).status, 200);
    if (manual) assert.equal((await request('/api/listings/' + row._id + '/availability', { actor: owner, method: 'PUT', body: { available: false } })).status, 200);
    assert.equal((await request('/api/bookings/' + visits[0]._id + '/cancel', { method: 'PUT' })).status, 200);
    assert.equal((await Listing.findById(row._id)).available, false);
    assert.equal((await request('/api/bookings/' + visits[1]._id + '/cancel', { actor: stranger, method: 'PUT' })).status, 200);
    assert.equal((await Listing.findById(row._id)).available, !manual);
  }
});

test('concurrent owner Make Unavailable and customer interest retain the owner restriction after cancellation', async () => {
  const { row, visits: [visit] } = await decisionFixture();
  const results = await Promise.all([recordDecision(visit, 'interested'),
    request('/api/listings/' + row._id + '/availability', { actor: owner, method: 'PUT', body: { available: false } })]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal((await request('/api/bookings/' + visit._id + '/cancel', { method: 'PUT' })).status, 200);
  assert.equal((await Listing.findById(row._id)).available, false);
});

test('SMTP reset configuration supports Gmail TLS and rejects unsafe production frontend origins without exposing credentials', () => {
  for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'APP_BASE_URL']) {
    assert.throws(() => resetEmailConfig({ ...smtpFixture, [key]: '' }));
  }
  const config = resetEmailConfig({ ...smtpFixture, SMTP_PORT: '587', NODE_ENV: 'production', APP_BASE_URL: 'https://rentsphere.example.test' });
  assert.equal(config.origin, 'https://rentsphere.example.test');
  assert.equal(config.options.secure, false); assert.equal(config.options.requireTLS, true);
  assert.equal(config.options.logger, false); assert.equal(config.options.debug, false);
  assert.equal(config.options.disableFileAccess, true); assert.equal(config.options.disableUrlAccess, true);
  for (const origin of ['http://localhost:5173', 'https://localhost', 'https://127.0.0.1', 'https://127.1.2.3', 'https://[::1]', 'https://0.0.0.0', 'https://app.localhost', 'http://rentsphere.example.test', 'https://rentsphere.example.test/login', 'https://user:pass@rentsphere.example.test', 'https://rentsphere.example.test/?token=secret']) {
    assert.throws(() => resetEmailConfig({ ...smtpFixture, NODE_ENV: 'production', APP_BASE_URL: origin }));
  }
  assert.equal(resetEmailConfig(smtpFixture).origin, 'http://localhost:5173');
});

test('password reset completes SMTP delivery before returning a generic response', async () => {
  const account = await User.create({ name: 'Delivery completion fixture', email: randomUUID() + '@example.test', password: 'KeepExistingPassword!' });
  let release, started;
  const wait = new Promise(resolve => { release = resolve; });
  const sending = new Promise(resolve => { started = resolve; });
  deliveryGate = { wait, started };
  let response;
  const pending = request('/api/auth/forgot-password', { actor: null, method: 'POST', body: { email: account.email } }).then(result => { response = result; return result; });
  try {
    await sending;
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(response, undefined, 'HTTP response must not end while SMTP delivery is still running');
    release();
    assert.deepEqual((await pending).data, { message: resetResponse });
    assert.equal(emails.at(-1).to, account.email);
  } finally { release(); await pending; deliveryGate = undefined; }
});

test('registration and login still work before and after password reset without role or owner approval changes', async () => {
  const email = randomUUID() + '@example.test', password = 'OriginalChosenPassword!';
  const registration = await request('/api/auth/register', { actor: null, method: 'POST', body: { name: 'Reset registration fixture', email, password, role: 'admin' } });
  assert.equal(registration.status, 201); assert.equal(registration.data.role, 'user');
  assert.equal((await request('/api/auth/login', { actor: null, method: 'POST', body: { email, password } })).status, 200);
  const before = await User.findById(registration.data._id).lean();
  await request('/api/auth/forgot-password', { actor: null, method: 'POST', body: { email } });
  const token = emails.at(-1).text.match(/reset-password#([a-f\d]{64})/)[1];
  const reset = await request('/api/auth/reset-password', { actor: null, method: 'POST', body: { token, password: 'NewChosenPassword!' } });
  assert.equal(reset.status, 200); assert.deepEqual(Object.keys(reset.data), ['message']);
  assert.equal((await request('/api/auth/login', { actor: null, method: 'POST', body: { email, password } })).status, 401);
  assert.equal((await request('/api/auth/login', { actor: null, method: 'POST', body: { email, password: 'NewChosenPassword!' } })).status, 200);
  const after = await User.findById(before._id).lean();
  assert.equal(after.role, before.role); assert.deepEqual(after.ownerProfile, before.ownerProfile);
});

test('password reset uses private SMTP config, hashes expiring tokens, protects account enumeration and preserves existing passwords until redemption', async () => {
  await Promise.all([PasswordReset.init(), ResetThrottle.init()]);
  const account = await User.create({ name: 'Reset fixture', email: randomUUID() + '@example.test', password: 'OriginalChosenPassword!', role: 'user' });
  const before = await User.findById(account._id).lean();
  const unknown = await request('/api/auth/forgot-password', { actor: null, method: 'POST', body: { email: randomUUID() + '@example.test' } });
  const known = await request('/api/auth/forgot-password', { actor: null, method: 'POST', body: { email: account.email.toUpperCase() } });
  assert.equal(known.status, 200); assert.deepEqual(known, unknown); assert.equal(known.data.message, resetResponse);
  assert.equal(emails.at(-1).to, account.email); assert.equal(emails.at(-1).from, smtpFixture.EMAIL_FROM);
  const token = emails.at(-1).text.match(/reset-password#([a-f\d]{64})/)[1];
  const stored = await PasswordReset.collection.findOne({ _id: account._id });
  assert.ok(stored.tokenHash); assert.ok(!JSON.stringify(stored).includes(token));
  assert.ok(stored.expiresAt.getTime() > Date.now()); assert.ok(stored.expiresAt.getTime() <= Date.now() + 15 * 60000);
  assert.equal((await User.findById(account._id)).password, before.password);
  assert.equal(Object.keys(known.data).join(','), 'message');
  const options = resetEmailConfig(smtpFixture).options;
  assert.equal(options.secure, true); assert.equal(options.requireTLS, true); assert.equal(options.logger, false);
  const missingConfig = await request('/api/unconfigured-auth/forgot-password', { actor: null, method: 'POST', body: { email: account.email } });
  assert.equal(missingConfig.status, 503);
});

test('reset token redemption is one-time under concurrency, hashes the chosen password and revokes old sessions without changing role or account ID', async () => {
  const account = await User.create({ name: 'One-time reset fixture', email: randomUUID() + '@example.test', password: 'OldChosenPassword!', role: 'user' });
  await request('/api/auth/forgot-password', { actor: null, method: 'POST', body: { email: account.email } });
  const token = emails.at(-1).text.match(/reset-password#([a-f\d]{64})/)[1];
  const results = await Promise.all(Array.from({ length: 2 }, () => request('/api/auth/reset-password', { actor: null, method: 'POST', body: { token, password: 'MyNewChosenPassword!' } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  const updated = await User.findById(account._id);
  assert.ok(await bcrypt.compare('MyNewChosenPassword!', updated.password)); assert.notEqual(updated.password, 'MyNewChosenPassword!');
  assert.equal(String(updated._id), String(account._id)); assert.equal(updated.role, 'user'); assert.equal(updated.authVersion, 1);
  assert.equal(await PasswordReset.countDocuments({ _id: account._id }), 0);
  assert.equal((await request('/api/bookings/mybookings', { actor: account })).status, 401);
  const login = await request('/api/auth/login', { actor: null, method: 'POST', body: { email: account.email, password: 'MyNewChosenPassword!' } });
  assert.equal(login.status, 200);
  const response = await fetch(origin + '/api/bookings/mybookings', { headers: { Authorization: 'Bearer ' + login.data.token } });
  assert.equal(response.status, 200);
  assert.equal((await request('/api/auth/login', { actor: null, method: 'POST', body: { email: account.email, password: 'OldChosenPassword!' } })).status, 401);
});

test('expired, malformed and invalid reset tokens fail; weak passwords do not consume tokens; request limits apply to known and unknown emails', async () => {
  const account = await User.create({ name: 'Expired reset fixture', email: randomUUID() + '@example.test', password: 'KeepExistingPassword!', role: 'user' });
  await request('/api/auth/forgot-password', { actor: null, method: 'POST', body: { email: account.email } });
  const token = emails.at(-1).text.match(/reset-password#([a-f\d]{64})/)[1];
  assert.equal((await request('/api/auth/reset-password', { actor: null, method: 'POST', body: { token, password: 'x' } })).status, 400);
  assert.equal(await PasswordReset.countDocuments({ _id: account._id }), 1);
  await PasswordReset.updateOne({ _id: account._id }, { $set: { expiresAt: new Date(Date.now() - 60000) } });
  for (const invalid of [token, randomBytes(32).toString('hex'), 'bad-token']) assert.equal((await request('/api/auth/reset-password', { actor: null, method: 'POST', body: { token: invalid, password: 'StrongChosenPassword!' } })).status, 400);
  for (const email of [account.email, randomUUID() + '@example.test']) {
    let status;
    for (let count = 0; count < 6; count++) status = (await request('/api/auth/forgot-password', { actor: null, method: 'POST', body: { email } })).status;
    assert.equal(status, 429);
  }
});

test('SMTP failures are handled without leaking tokens or changing passwords, and invalidation removes the unusable token', async t => {
  const account = await User.create({ name: 'Delivery fixture', email: randomUUID() + '@example.test', password: 'ExistingPassword!', role: 'user' });
  const before = (await User.findById(account._id)).password;
  failDelivery = true;
  const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  try {
    const response = await request('/api/auth/forgot-password', { actor: null, method: 'POST', body: { email: account.email } });
    assert.equal(response.status, 200); assert.equal(response.data.message, resetResponse);
    for (let attempts = 0; attempts < 50 && (!logs.length || await PasswordReset.countDocuments({ _id: account._id })); attempts++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await PasswordReset.countDocuments({ _id: account._id }), 0);
    assert.equal((await User.findById(account._id)).password, before);
    assert.ok(logs.every(line => !line.includes(account.email) && !line.includes('reset-password#') && !line.includes(smtpFixture.SMTP_PASS)));
  } finally { failDelivery = false; }
});

test('owner review never promotes historical hosts automatically or downgrades an admin', async () => {
  assert.equal((await request('/api/admin/owners/' + admin._id + '/approve', { actor: admin, method: 'PUT' })).status, 400);
  assert.equal((await request('/api/admin/owners/' + admin._id + '/reject', { actor: admin, method: 'PUT', body: {} })).status, 400);
  assert.equal((await request('/api/admin/owners/' + customer._id + '/approve', { actor: admin, method: 'PUT' })).status, 409);
  assert.equal((await User.findById(customer._id)).role, 'user'); assert.equal((await User.findById(admin._id)).role, 'admin');
  const applicant = await User.create({ name: 'Pending applicant', email: randomUUID() + '@example.test', password: 'ApplicantPassword!', role: 'owner', ownerProfile: { status: 'pending', listingIntent: 'both' } });
  assert.equal((await request('/api/listings', { actor: applicant, method: 'POST', body: { ...hostingFixture(), type: 'property', location: 'Mumbai', price: 900 } })).status, 403);
  assert.equal((await request('/api/admin/owners/' + applicant._id + '/approve', { actor: admin, method: 'PUT' })).status, 200);
  assert.equal((await User.findById(applicant._id)).ownerProfile.status, 'approved');
  assert.equal((await request('/api/listings', { actor: applicant, method: 'POST', body: { ...hostingFixture(), type: 'property', location: 'Mumbai', price: 900 } })).status, 201);
});

test('deleting a listing saved by a customer archives it without dangling saved references', async () => {
  const row = await listing();
  assert.equal((await request('/api/saved/' + row._id, { method: 'PUT' })).status, 200);
  assert.equal((await request('/api/listings/' + row._id, { actor: owner, method: 'DELETE' })).status, 200);
  assert.ok((await Listing.findById(row._id)).archivedAt);
  assert.equal((await request('/api/saved')).data.length, 0);
  assert.equal((await request('/api/saved/' + row._id, { method: 'DELETE' })).status, 200);
});

test('concurrent save/removal and admin account deletion cannot leave dangling saved-listing or ownership references', async () => {
  const dedicated = await User.create({ name: 'Reference owner', email: randomUUID() + '@example.test', password: 'ReferencePassword!', role: 'owner', ownerProfile: { status: 'approved', listingIntent: 'both' } });
  const protectedRow = await listing('vehicle', dedicated);
  assert.equal((await request('/api/saved/' + protectedRow._id, { method: 'PUT' })).status, 200);
  assert.equal((await request('/api/admin/users/' + dedicated._id, { actor: admin, method: 'DELETE' })).status, 409);
  assert.ok(await User.findById(dedicated._id)); assert.ok(await Listing.findById(protectedRow._id));
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await listing();
    const results = await Promise.all([
      request('/api/saved/' + row._id, { method: 'PUT' }),
      request('/api/listings/' + row._id, { actor: owner, method: 'DELETE' }),
    ]);
    assert.ok([200, 404].includes(results[0].status)); assert.ok([200, 409].includes(results[1].status));
    const saved = (await User.findById(customer._id).select('+savedListings')).savedListings || [];
    if (saved.some(id => String(id) === String(row._id))) assert.ok(await Listing.findById(row._id));
  }
});
