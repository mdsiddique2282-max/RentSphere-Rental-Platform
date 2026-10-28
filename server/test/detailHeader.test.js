import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detailHeader, vehicleBookingDisplay } from '../../src/data/detailHeader.js';

test('property headers use the actual category and current availability for sample and genuine listings', () => {
  for (const inventoryKind of [undefined, 'sample']) {
    for (const category of ['Apartment', 'House', 'Villa', 'Studio']) {
      const listing = { type: 'property', category, inventoryKind, status: 'available', availability: 'Available now' };
      assert.equal(detailHeader(listing, true), `${category} · Available`);
      assert.equal(detailHeader({ ...listing, status: 'rented' }, true), `${category} · Unavailable`);
      assert.equal(detailHeader({ ...listing, availability: 'Not available' }, true), `${category} · Unavailable`);
      assert.equal(detailHeader(listing, true, true), `${category} · Unavailable`);
    }
  }
  assert.equal(detailHeader({ type: 'House', availability: 'Available now' }, true), 'House · Available');
});

test('vehicle headers preserve kind/category mapping and unavailable signals override available state', () => {
  for (const inventoryKind of [undefined, 'sample']) {
    for (const kind of ['Bike', 'Car', 'SUV']) {
      const listing = { type: 'vehicle', kind, category: 'Different category', inventoryKind, status: 'available', vehicleBookingStatus: 'available' };
      assert.equal(detailHeader(listing, false), `${kind} · AVAILABLE`);
      assert.equal(detailHeader({ ...listing, vehicleBookingStatus: 'partially-booked' }, false), `${kind} · PARTIALLY BOOKED`);
      for (const unavailable of [{ available: false }, { status: 'rented' }, { availability: 'Unavailable' }, { badge: 'Booked' }]) {
        assert.equal(detailHeader({ ...listing, ...unavailable, vehicleBookingStatus: 'partially-booked' }, false), `${kind} · CURRENTLY UNAVAILABLE`);
      }
    }
  }
  assert.equal(detailHeader({ type: 'vehicle', category: 'SUV', available: true, vehicleBookingStatus: 'available' }, false), 'SUV · AVAILABLE');
  assert.equal(detailHeader({ type: 'SUV', kind: 'Car', available: false, badge: 'Premium' }, false), 'Car · CURRENTLY UNAVAILABLE');
  assert.equal(vehicleBookingDisplay({ _id: 'database-vehicle', status: 'available' }).state, 'loading');
  assert.equal(vehicleBookingDisplay({ _id: 'database-vehicle', status: 'available' }).label, 'Checking availability…');
});

test('detail header remains two-part; sample label is on location line, with no credits accordion around gallery', async () => {
  const source = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  const header = source.slice(source.indexOf('<section className="detail-top">'), source.indexOf('<section className="gallery">'));
  assert.match(header, /<span className=\{isProperty \? 'eyebrow'[^\n]+\{detailHeader\(item, isProperty, listingRented\)\}<\/span>/);
  assert.match(header, /<p className="location">[^\n]+\{isSample\(item\) && <span/);
  assert.doesNotMatch(source, /Photo credits|<details/);
  const galleryAndInterest = source.slice(source.indexOf('<section className="gallery">'), source.indexOf('<h2>At a glance</h2>'));
  assert.doesNotMatch(galleryAndInterest, /mediaCredits|Images:/);
  assert.match(galleryAndInterest, /onClick=\{\(\) => setActive\(i\)\}/);
});
