import test from 'node:test';
import assert from 'node:assert/strict';
import { assertListingManager, assertPublisher, assertRequestTransition, listingUpdate } from '../utils/workflowPolicy.js';

const host = { _id: 'host', role: 'owner', ownerProfile: { status: 'approved' } };
const admin = { _id: 'admin', role: 'admin' };
const customer = { _id: 'customer', role: 'user' };

test('only approved owners/admins can publish, and approval never grants access to another host', () => {
  for (const actor of [customer, { ...host, ownerProfile: { status: 'pending' } },
    { ...host, ownerProfile: { status: 'rejected' } }, { ...customer, ownerProfile: { status: 'approved' } }]) {
    assert.throws(() => assertPublisher(actor), { status: 403 });
  }
  assertPublisher(host);
  assertListingManager(host, { host: host._id });
  assertListingManager(admin, { host: host._id });
  assert.throws(() => assertListingManager({ ...host, _id: 'stranger' }, { host: host._id }), { status: 403 });
});

test('listing allowlist rejects protected fields, operators, nested paths and invalid values', () => {
  for (const field of ['host', 'owner', 'role', '_id', 'id', '__v', 'type', 'rating', 'bookingRevision',
    'verified', 'verificationStatus', 'hostingDetailsVersion', 'ownerProfile', 'ownerProfile.status', 'createdAt', 'updatedAt', '$set', '__proto__']) {
    assert.throws(() => listingUpdate({ title: 'Legitimate title', [field]: 'forged' }), { status: 400 });
  }
  for (const body of [null, [], {}, { price: -1 }, { price: '100' }, { title: {} }, { features: [{}] },
    { status: 'confirmed' }, { image: '/uploads/../../.env' }, { gallery: ['/uploads/..\\private.pdf'] }]) {
    assert.throws(() => listingUpdate(body), { status: 400 });
  }
  assert.deepEqual(listingUpdate({ title: 'Updated', price: 1000, amenities: ['Parking'], status: 'available' }),
    { title: 'Updated', price: 1000, amenities: ['Parking'], status: 'available' });
});

for (const kind of ['vehicle', 'property_visit']) {
  test(`${kind}: full transition matrix enforces customer cancellation and host/admin decisions`, () => {
    const base = { kind, customerId: customer._id, hostId: host._id };
    for (const actor of [host, admin]) {
      for (const to of ['confirmed', 'rejected']) assertRequestTransition({ ...base, actor, from: 'pending', to });
      assertRequestTransition({ ...base, actor, from: 'confirmed', to: 'confirmed' });
      for (const from of ['cancelled', 'rejected']) {
        for (const to of ['confirmed', 'rejected', 'pending']) {
          assert.throws(() => assertRequestTransition({ ...base, actor, from, to }), { status: 409 });
        }
      }
      assert.throws(() => assertRequestTransition({ ...base, actor, from: 'confirmed', to: 'rejected' }), { status: 409 });
      assert.throws(() => assertRequestTransition({ ...base, actor, from: 'pending', to: 'cancelled' }), { status: 403 });
    }
    for (const from of ['pending', 'confirmed']) assertRequestTransition({ ...base, actor: customer, from, to: 'cancelled' });
    for (const from of ['cancelled', 'rejected']) {
      assert.throws(() => assertRequestTransition({ ...base, actor: customer, from, to: 'cancelled' }), { status: 409 });
    }
    for (const actor of [customer, { ...host, _id: 'other-owner' }, { ...host, ownerProfile: { status: 'rejected' } }]) {
      for (const to of ['confirmed', 'rejected']) {
        assert.throws(() => assertRequestTransition({ ...base, actor, from: 'pending', to }), { status: 403 });
      }
    }
  });
}
