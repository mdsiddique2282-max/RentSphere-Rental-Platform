import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import sharp from 'sharp';
import mongoose from 'mongoose';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { startQuickCatalogDatabase, verifyPreviewAssets } from '../utils/quickCatalogPreview.js';
import { importCatalog, validateCatalog, readiness, requireApproval, requireTemporarySampleApproval, validateTemporarySample, digest } from '../utils/catalogImport.js';
import { mergeCatalog, recommendedOrder, sampleNotice, unavailablePhoto, isCorrectedPreviewVehicle, previewVehicleAvailability, includedFeatures } from '../../src/data/catalog.js';
import { generateToken } from '../utils/tokens.js';
import listingRoutes from '../routes/listings.js';
import bookingRoutes from '../routes/bookings.js';
import authRoutes from '../routes/auth.js';
import Booking from '../models/Booking.js';

let preview, server, origin, vite;
before(async () => {
  preview = await startQuickCatalogDatabase();
  await Booking.init();
  const app = express(); app.use(express.json());
  app.use('/api/listings', listingRoutes); app.use('/api/bookings', bookingRoutes); app.use('/api/auth', authRoutes);
  app.use('/catalog-placeholders', express.static(fileURLToPath(new URL('../../public/catalog-placeholders/', import.meta.url))));
  app.use('/catalog-media', express.static(fileURLToPath(new URL('../../public/catalog-media/', import.meta.url))));
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  origin = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 180000 });
after(async () => {
  await vite?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await preview?.close();
});

test('15+15 selection reuses original IDs, rates and details rather than replacing data', async () => {
  const full = JSON.parse(await readFile(new URL('../catalog/mumbai-2026.json', import.meta.url), 'utf8'));
  assert.equal(preview.catalog.selection.sourceManifestSha256, digest(full));
  assert.equal(validateCatalog(preview.catalog).total, 30);
  for (const record of preview.catalog.records) {
    assert.deepEqual(record.listing, full.records.find(row => row.key === record.key).listing);
  }
  assert.equal(preview.result.inserted, 30);
  assert.equal(await mongoose.connection.db.collection('listings').countDocuments(), 30);
});

test('all 30 database listings are visible through existing catalog/detail routes with distinct working image assets', async () => {
  let photos = 0, placeholders = 0; const unique = new Set();
  for (const type of ['property', 'vehicle']) {
    const response = await fetch(`${origin}/api/listings?type=${type}`);
    assert.equal(response.status, 200);
    const rows = await response.json(); assert.equal(rows.length, 15);
    for (const row of rows) {
      assert.equal(row.inventoryKind, 'sample'); assert.equal(row.previewOnly, true);
      const detail = await fetch(`${origin}/api/listings/${row._id}`);
      assert.equal(detail.status, 200);
      assert.ok(row.gallery.length >= (type === 'property' ? 3 : 2));
      for (const path of row.gallery) {
        const asset = await fetch(`${origin}${path}`); assert.equal(asset.status, 200, path);
        const bytes = Buffer.from(await asset.arrayBuffer());
        assert.equal(unique.has(path), false); unique.add(path);
        if (path.endsWith('.svg')) {
          placeholders++;
          assert.match(bytes.toString('utf8'), /This is not a photograph\./);
          assert.match(bytes.toString('utf8'), /DEMO \/ SAMPLE/);
          assert.doesNotMatch(bytes.toString('utf8'), /<image\b/);
          assert.equal((await sharp(bytes).metadata()).width, 1600);
        } else {
          photos++;
          assert.ok((await sharp(bytes).metadata()).width >= 1600);
          assert.equal(row.mediaCredits.length, row.gallery.length);
          assert.ok(row.mediaCredits.every(credit => credit.author && credit.license && credit.sourcePage));
        }
      }
    }
  }
  const assets = preview.catalog.records.flatMap(record => record.previewGallery);
  assert.equal(photos, assets.filter(asset => asset.kind === 'photograph').length);
  assert.equal(placeholders, assets.filter(asset => asset.kind === 'placeholder').length);
});

test('all 30 legacy samples require real login, preserve pickup and block Home Delivery without a confirmed map location', async () => {
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@rentsphere.test', password: 'RentSphereDemo2026!' }) });
  assert.equal(login.status, 200); const user = await login.json(); assert.ok(user.token);
  const ids = new Set();
  for (const record of preview.catalog.records) {
    const path = record.listing.type === 'property' ? '/api/bookings/visits' : '/api/bookings';
    const body = { listingId: record.listing._id, startDate: '2090-05-01', endDate: '2090-05-03',
      fulfilment: 'pickup', contact: { name: 'Demo User', email: 'demo@rentsphere.test', phone: '9999999999' } };
    const submit = token => fetch(`${origin}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await submit()).status, 401);
    if (record.listing.type === 'vehicle') {
      const delivery = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` }, body: JSON.stringify({ ...body, fulfilment: 'delivery', deliveryAddress: 'Mumbai test address' }) });
      assert.equal(delivery.status, 400);
    }
    const saved = await submit(user.token); assert.equal(saved.status, 201);
    const data = await saved.json(); assert.equal(data.status, 'pending');
    assert.equal(data.inventoryKind, 'sample'); assert.match(data.sampleDisclosure, /not a verified/);
    assert.equal(data.deliveryCharge, 0);
    assert.equal(data.totalPrice, record.listing.type === 'property' ? 0 : record.listing.price * 2);
    ids.add(data.requestId);
    assert.equal((await submit(user.token)).status, 409);
  }
  assert.equal(ids.size, 30);
  assert.equal(await Booking.countDocuments(), 30);
  const mine = await fetch(`${origin}/api/bookings/mybookings`, { headers: { Authorization: `Bearer ${generateToken(preview.user._id)}` } });
  assert.equal((await mine.json()).length, 30);
});

test('preview policy cannot be used with another database/client, and normal live gates still reject placeholders', async () => {
  let touched = false;
  await assert.rejects(importCatalog({ client: { db() { touched = true; } }, catalog: preview.catalog,
    targetDatabase: 'live', isolatedPreviewToken: preview.token, verifyPhotos: verifyPreviewAssets }), /disposable database/);
  assert.equal(touched, false);
  assert.equal(readiness(preview.catalog).filter(row => row.ready).length, 0);
  assert.throws(() => requireApproval(preview.catalog, { approved: true, presentationReviewed: true,
    manifestSha256: digest(preview.catalog), targetDatabase: 'live', assignments: Object.fromEntries(preview.catalog.records.map(row => [row.key, { host: row.listing.host, approved: true }])) }, 'live'), /blocked/);
  const again = await importCatalog({ client: preview.client, catalog: preview.catalog,
    targetDatabase: preview.targetDatabase, isolatedPreviewToken: preview.token, verifyPhotos: verifyPreviewAssets });
  assert.equal(again.inserted, 0); assert.equal(again.skipped, 30); assert.equal(again.preservedBookings, 30);
});

test('database samples replace duplicate frontend demos and owner-first default preserves explicit price sorting', () => {
  const samples = preview.catalog.records.map(record => ({ ...record.listing, id: record.listing._id }));
  assert.equal(mergeCatalog(samples, [{ id: 'V101' }]).length, 30);
  assert.equal(mergeCatalog([{ id: 'real' }], [{ id: 'legacy' }]).length, 2);
  const owner = { id: 'owner', createdAt: '2020-01-01', price: 900000 };
  const sorted = [...samples, owner].sort(recommendedOrder); assert.equal(sorted[0].id, 'owner');
  assert.ok([...sorted].sort((a, b) => a.price - b.price)[0].price < owner.price);
  assert.match(sampleNotice(samples[0]), /DEMO \/ SAMPLE REQUEST/); assert.equal(sampleNotice(owner), '');
  assert.match(decodeURIComponent(unavailablePhoto(samples[0])), /not a real rental offer/);
});

test('temporary sample import still requires explicit target, owners, details, presentation and placeholder approval', () => {
  const catalog = preview.catalog;
  const receipt = { approved: true, presentationReviewed: true, temporaryPlaceholdersApproved: true,
    sampleDetailsApproved: true, manifestSha256: digest(catalog), targetDatabase: 'isolated_approval_fixture',
    assignments: Object.fromEntries(catalog.records.map(row => [row.key, { host: row.listing.host, approved: true }])) };
  assert.doesNotThrow(() => requireTemporarySampleApproval(catalog, receipt, receipt.targetDatabase));
  for (const change of [
    value => { value.approved = false; }, value => { value.temporaryPlaceholdersApproved = false; },
    value => { value.sampleDetailsApproved = false; }, value => { value.presentationReviewed = false; },
    value => { value.manifestSha256 = 'wrong'; }, value => { value.assignments.P01.approved = false; },
    value => { value.targetDatabase = 'another'; },
  ]) { const value = structuredClone(receipt); change(value); assert.throws(() => requireTemporarySampleApproval(catalog, value, receipt.targetDatabase)); }
  const wrong = structuredClone(catalog); wrong.records[0].previewGallery[0].kind = 'photograph';
  assert.throws(() => validateTemporarySample(wrong), /Untrusted/);
  const unlicensed = structuredClone(catalog); unlicensed.records.find(row => row.key === 'M06').media[0].rightsApproved = false;
  assert.throws(() => validateTemporarySample(unlicensed), /photographs failed/);
});

test('explicitly approved placeholder import is insert-only, publishable and idempotent in a separate disposable test DB', async () => {
  const targetDatabase = `${preview.targetDatabase.slice(0, 42)}_approved`;
  const db = preview.client.db(targetDatabase);
  const host = new mongoose.mongo.ObjectId(preview.catalog.records[0].listing.host);
  await db.collection('users').insertOne({ _id: host, role: 'admin', name: 'Approval test fixture only' });
  const legacy = { _id: new mongoose.mongo.ObjectId(), name: 'Preserved fixture', host, price: 1234, status: 'available' };
  await db.collection('listings').insertOne(legacy);
  const historical = { listing: legacy._id, status: 'confirmed', requestId: 'preserve-fixture' };
  await db.collection('bookings').insertOne(historical);
  const approval = { approved: true, presentationReviewed: true, temporaryPlaceholdersApproved: true,
    sampleDetailsApproved: true, publishSamples: true, manifestSha256: digest(preview.catalog), targetDatabase,
    assignments: Object.fromEntries(preview.catalog.records.map(row => [row.key, { host: row.listing.host, approved: true }])) };
  const options = { client: preview.client, catalog: preview.catalog, targetDatabase, approval, verifyPhotos: verifyPreviewAssets };
  assert.equal((await importCatalog(options)).inserted, 30);
  assert.equal((await importCatalog(options)).skipped, 30);
  assert.equal(await db.collection('listings').countDocuments(), 31);
  assert.equal(await db.collection('listings').countDocuments({ inventoryKind: 'sample', publicationState: 'published' }), 30);
  assert.equal(await db.collection('listings').countDocuments({ previewOnly: true }), 0);
  assert.deepEqual(await db.collection('listings').findOne({ _id: legacy._id }), legacy);
  assert.equal(await db.collection('bookings').countDocuments(), 1);
});

test('existing card components render each DB sample with honest labels and no fictional star ratings', async () => {
  vite = await createViteServer({ root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false, envDir: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { MemoryRouter } = await import('react-router-dom');
  const { PropertyCard, VehicleCard } = await vite.ssrLoadModule('/src/components/ListingCards.jsx');
  const rows = await (await fetch(origin + '/api/listings')).json();
  for (const item of rows) {
    const html = renderToStaticMarkup(React.createElement(MemoryRouter, null,
      React.createElement(item.type === 'property' ? PropertyCard : VehicleCard, { item, saved: false, onSave() {} })));
    if (isCorrectedPreviewVehicle(item)) {
      assert.match(html, /Sample · unverified/);
      assert.match(html, /class="status vehicle-status vehicle-status--available">AVAILABLE/);
      assert.doesNotMatch(html, /Sample inventory/);
    } else { assert.match(html, /Sample · unverified/); }
    assert.doesNotMatch(html, /★ 4\.5/); assert.match(html, new RegExp(String(item._id)));
    if (item.bhk === 0) { assert.match(html, /Studio/); assert.doesNotMatch(html, /2 BHK/); }
  }
});

test('genuine property and vehicle cards receive no sample labels', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { MemoryRouter } = await import('react-router-dom');
  const { PropertyCard, VehicleCard } = await vite.ssrLoadModule('/src/components/ListingCards.jsx');
  for (const [type, Card] of [['property', PropertyCard], ['vehicle', VehicleCard]]) {
    const html = renderToStaticMarkup(React.createElement(MemoryRouter, null,
      React.createElement(Card, { item: { id: 'genuine-test', type, title: 'Genuine listing', name: 'Genuine listing', image: '/genuine.jpg', price: 1000 }, saved: false, onSave() {} })));
    assert.doesNotMatch(html, /Sample|Demo|unverified/);
  }
});

test('only the five preview vehicles use supported features and actual availability state', async () => {
  for (const key of ['M01', 'M03', 'M10', 'M15', 'M17']) {
    const row = await mongoose.connection.db.collection('listings').findOne({ catalogKey: `mumbai-2026-${key}` });
    assert.equal(isCorrectedPreviewVehicle(row), true);
    assert.deepEqual(includedFeatures({ ...row, amenities: [] }), row.features);
    assert.equal(previewVehicleAvailability(row), 'Available');
    assert.equal(previewVehicleAvailability({ ...row, status: 'rented' }), 'Unavailable');
    assert.equal(previewVehicleAvailability({ ...row, available: false }), 'Unavailable');
    assert.equal(previewVehicleAvailability({ ...row, availability: 'Unavailable' }), 'Unavailable');
    assert.equal(isCorrectedPreviewVehicle({ ...row, previewOnly: false }), false);
  }
  assert.equal(isCorrectedPreviewVehicle({ id: 'V103', name: 'Hyundai Creta' }), false);
  assert.equal(isCorrectedPreviewVehicle({ id: 'V201', name: 'Himalayan 450' }), false);
});

test('all five real detail pages retain Creta structure, exact catalog data, features, gallery and credits', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { MemoryRouter } = await import('react-router-dom');
  const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
  const { AuthContext } = await vite.ssrLoadModule('/src/context/AuthContext.jsx');
  const { vehicles } = await vite.ssrLoadModule('/src/data/listings.js');
  const originalLength = vehicles.length;
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem() { return null; } };
  const render = id => renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [`/vehicles/${id}`] },
    React.createElement(AuthContext.Provider, { value: { user: null, logout() {} } }, React.createElement(App))));
  try {
    const reference = render('V103');
    const sections = ['At a glance', 'About this ride', 'Included features', 'Rental partner', 'Good to know', 'Similar rides'];
    for (const title of sections) assert.ok(reference.toLowerCase().includes(title.toLowerCase()), title);
    for (const key of ['M01', 'M03', 'M10', 'M15', 'M17']) {
      const row = await (await fetch(`${origin}/api/listings/${preview.catalog.records.find(row => row.key === key).listing._id}`)).json();
      vehicles.push({ ...row, id: row._id });
      const html = render(row._id);
      for (const title of sections) assert.ok(html.toLowerCase().includes(title.toLowerCase()), `${key}: ${title}`);
      assert.ok(html.includes(`<h1>${row.name}</h1>`), key);
      for (const text of [row.location, row.fuel, row.transmission, row.category, row.description]) assert.ok(html.includes(text), text);
      assert.ok(html.includes(`₹${Number(row.price).toLocaleString('en-IN')}`));
      const features = html.split('<div class="amenities">')[1]?.split('</div>')[0];
      assert.ok(features, key);
      for (const feature of row.features) assert.ok(features.includes(feature), `${key}: ${feature}`);
      assert.doesNotMatch(features, /Verified listing|24\/7 support/);
      const gallery = html.split('<section class="gallery">')[1]?.split('</section>')[0];
      assert.equal((gallery.match(/<img /g) || []).length, 3, key); // Main image + two thumbnails.
      for (const image of row.gallery) assert.ok(gallery.includes(image), image);
      for (const credit of row.mediaCredits) {
        assert.ok(html.includes(credit.sourcePage)); assert.ok(html.includes(credit.licenseUrl));
      }
      assert.match(html, /Sample · unverified/);
      assert.doesNotMatch(html, /Photo credits|<details/);
      assert.match(html, /class="shell site-image-credits"/);
      const ownerCard = html.split('<div class="owner-card">')[1].split('<div class="rental-note">')[0];
      assert.doesNotMatch(ownerCard, /Images:|Image credits:|CC BY/);
      const footer = html.slice(html.indexOf('<footer'));
      for (const credit of row.mediaCredits) { assert.ok(footer.includes(credit.sourcePage)); assert.ok(footer.includes(credit.licenseUrl)); }
      assert.doesNotMatch(html, /Demo listing · reference photos · unverified specifications|Demo \/ Sample inventory/);
      assert.match(html, /class="save-button /); assert.match(html, /Book now/);
      assert.doesNotMatch(html, /<strong>Demo \/ Sample<\/strong>/);
    }
  } finally { vehicles.splice(originalLength); globalThis.localStorage = previousStorage; }
});
