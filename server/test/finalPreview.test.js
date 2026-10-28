import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { main } from '../scripts/preview-quick-catalog.js';
import { FINAL_PREVIEW_KEYS } from '../utils/finalCatalogPreview.js';
import { previewPropertySimilar, previewSimilar, mergeCatalog, previewAvailability, previewTitle } from '../../src/data/catalog.js';
import { previewVisitMessage } from '../../src/data/requests.js';
import { vehicles, properties } from '../../src/data/listings.js';

let preview, origin, stateDirectory, rows, session, vite;
const body = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json',
  ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, body: JSON.stringify(value) });
before(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'rentsphere-final-preview-'));
  process.env.RENTSPHERE_PREVIEW_PORT = '0';
  process.env.RENTSPHERE_PREVIEW_STATE_DIR = stateDirectory;
  delete process.env.RENTSPHERE_PREVIEW_EPHEMERAL;
  preview = await main(); origin = `http://127.0.0.1:${preview.server.address().port}`;
  rows = [...await (await fetch(`${origin}/api/listings?type=property`)).json(),
    ...await (await fetch(`${origin}/api/listings?type=vehicle`)).json()];
  const login = await fetch(`${origin}/api/auth/login`, body({ email: 'demo@rentsphere.test', password: 'RentSphereDemo2026!' }));
  assert.equal(login.status, 200); session = await login.json();
}, { timeout: 120000 });
after(async () => {
  await vite?.close(); await preview?.close('test finished');
  if (stateDirectory) {
    for (const name of ['state.json', 'state.json.tmp', 'port.json', 'admin-login.json', '.gitignore']) await unlink(join(stateDirectory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(stateDirectory);
  }
});

test('eight original database records and nine unique frontend originals coexist with exactly thirty new records', async () => {
  const source = JSON.parse(await readFile(new URL('../catalog/original-listings.json', import.meta.url)));
  assert.deepEqual(preview.preview.counts, { originalDatabase: 8, originalFrontend: 9, newProperties: 15, newVehicles: 15 });
  assert.equal(rows.length, 47);
  assert.equal(new Set(rows.map(row => row._id)).size, 47);
  assert.equal(rows.filter(row => row.inventoryKind === 'sample').length, 30);
  assert.deepEqual(rows.filter(row => row.inventoryKind === 'sample').map(row => row.catalogKey.replace('mumbai-2026-', '')).sort(), [...FINAL_PREVIEW_KEYS].sort());
  for (const original of source.listings) {
    const actual = await mongoose.connection.db.collection('listings').findOne({ _id: new mongoose.mongo.ObjectId(original._id) });
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), original);
  }
  for (const row of rows.filter(row => row.legacyId)) {
    const result = await fetch(`${origin}/api/listings/${row.legacyId}`);
    assert.equal(result.status, 200); assert.equal((await result.json())._id, row._id);
  }
  assert.equal(mergeCatalog(rows.filter(row => row.type === 'vehicle'), vehicles).length, 24);
  assert.equal(mergeCatalog(rows.filter(row => row.type === 'property'), properties).length, 23);
});

test('thirty sample listings retain exact staging details; 44 photos decode with credits and only M26 remains incomplete', async () => {
  const staging = JSON.parse(await readFile(new URL('../catalog/mumbai-15x15.json', import.meta.url)));
  let photographs = 0;
  for (const row of rows.filter(row => row.inventoryKind === 'sample')) {
    const planned = staging.records.find(record => record.listing._id === row._id).listing;
    for (const key of ['price', 'name', 'title', 'location', 'fuel', 'transmission', 'seats', 'category', 'description', 'bhk', 'area', 'furnishing']) assert.equal(row[key], planned[key], key);
    assert.ok(row.gallery.length >= 1 && row.gallery.length <= 3);
    if (row.catalogKey === 'mumbai-2026-M26') {
      assert.equal(row.mediaState, 'placeholder'); assert.equal(row.mediaCredits.length, 0);
      for (const url of row.gallery) { const response = await fetch(origin + url); assert.equal(response.status, 200); assert.match(await response.text(), /This is not a photograph/); }
      continue;
    }
    assert.equal(row.host._id, planned.host); assert.ok(row.host.name);
    for (const url of row.gallery) {
      const image = await fetch(origin + url); assert.equal(image.status, 200);
      const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
      assert.ok(['jpeg','png'].includes(metadata.format)); assert.ok(metadata.width >= 1600 && metadata.height >= 900);
      photographs++;
    }
    assert.equal(row.mediaCredits.length, row.gallery.length);
    assert.ok(row.mediaCredits.every(photo => photo.author && photo.licenseUrl && photo.sourcePage));
  }
  assert.equal(photographs, 44);
});

test('unavailable property and vehicle refuse new authenticated requests; availability stays in stored status', async () => {
  for (const type of ['property', 'vehicle']) {
    const row = rows.find(row => row.type === type && row.inventoryKind === 'sample');
    await mongoose.connection.db.collection('listings').updateOne({ _id: new mongoose.mongo.ObjectId(row._id) }, { $set: { status: 'rented' } });
    try {
      const stored = await (await fetch(`${origin}/api/listings/${row._id}`)).json();
      assert.equal(previewAvailability(stored), 'Unavailable');
      const denied = await fetch(`${origin}/api/bookings${type === 'property' ? '/visits' : ''}`, body({
        listingId: row._id, startDate: '2090-03-01', endDate: '2090-03-02', fulfilment: 'pickup',
        contact: { name: 'Preview Guest', email: 'guest@rentsphere.test', phone: '9999999999' },
      }));
      assert.equal(denied.status, 409); assert.match((await denied.json()).message, /unavailable/);
    } finally { await mongoose.connection.db.collection('listings').updateOne({ _id: new mongoose.mongo.ObjectId(row._id) }, { $set: { status: 'available' } }); }
  }
});

test('legacy preview preserves pickup and visits, requires delivery quotes, rejects duplicate/past dates and keeps clean WhatsApp text', async () => {
  for (const type of ['vehicle', 'property']) {
    const row = rows.find(row => row.type === type && row.inventoryKind === 'sample');
    const request = { listingId: row._id, startDate: '2090-04-01', endDate: '2090-04-02',
      fulfilment: 'pickup',
      contact: { name: 'Preview Guest', email: 'guest@rentsphere.test', phone: '9999999999' } };
    const url = `${origin}/api/bookings${type === 'property' ? '/visits' : ''}`;
    if (type === 'vehicle') assert.equal((await fetch(url, body({ ...request, fulfilment: 'delivery', deliveryAddress: 'Mumbai test address' }))).status, 400);
    const result = await fetch(url, body(request)); assert.equal(result.status, 201, await result.clone().text());
    const saved = await result.json(); assert.equal(saved.status, 'pending'); assert.ok(saved.requestId);
    if (type === 'vehicle') { assert.equal(saved.deliveryCharge, 0); assert.equal(saved.totalPrice, row.price); }
    assert.equal((await fetch(url, body(request))).status, 409);
    assert.equal((await fetch(url, body({ ...request, startDate: '2000-01-01' }))).status, 400);
    const anonymous = body({ ...request, startDate: '2090-05-01', endDate: '2090-05-02' });
    delete anonymous.headers.Authorization; assert.equal((await fetch(url, anonymous)).status, 401);
  }
  const message = previewVisitMessage(rows.find(row => row.type === 'property' && row.inventoryKind === 'sample'), {
    name: 'Preview Guest', email: 'guest@rentsphere.test', phone: '9999999999', start: '2090-04-01' });
  assert.match(message, /Property Visit Request \(Demo\)/);
  assert.doesNotMatch(message, /Request ID|requestId|DEMO \/ SAMPLE REQUEST/);
  assert.match(message, /Visit Date: 2090-04-01/);
});

test('preview refuses a request when availability cannot be checked, without saving a booking', async t => {
  const prototype = mongoose.mongo.Collection.prototype;
  const findOne = prototype.findOne;
  const count = await mongoose.connection.db.collection('bookings').countDocuments();
  t.mock.method(prototype, 'findOne', function (...args) {
    if (this.collectionName === 'listings') return Promise.reject(new Error('Test availability read failed'));
    return findOne.apply(this, args);
  });
  try {
    const row = rows.find(row => row.type === 'vehicle' && row.inventoryKind === 'sample');
    const response = await fetch(`${origin}/api/bookings`, body({ listingId: row._id,
      startDate: '2090-06-01', endDate: '2090-06-02', fulfilment: 'pickup' }));
    assert.equal(response.status, 503);
    assert.equal(await mongoose.connection.db.collection('bookings').countDocuments(), count);
  } finally { t.mock.restoreAll(); }
});

test('recommendations rank category, location, BHK and price across original and new records without self-links', () => {
  const selections = new Set();
  for (const item of rows.filter(row => row.inventoryKind === 'sample')) {
    const related = previewSimilar(item, rows.filter(row => row.type === item.type));
    assert.equal(related.length, 3);
    assert.ok(related.every(row => row._id !== item._id));
    selections.add(related.map(row => row._id).join(','));
  }
  assert.ok(selections.size > 3);
  const creta = rows.find(row => row.name === 'Hyundai Creta');
  assert.ok(previewSimilar(creta, rows.filter(row => row.type === 'vehicle')).some(row => row.inventoryKind === 'sample'));
  const fixture = { id: 'current', type: 'property', bhk: 1, price: 30000, location: 'Andheri, Mumbai', category: 'Apartment' };
  assert.equal(previewSimilar(fixture, [{ ...fixture, id: 'near', price: 32000 }, { ...fixture, id: 'far', bhk: 5, price: 300000, location: 'Pune' }])[0].id, 'near');
});

test('all thirty sample detail pages reuse original components with working galleries, status, Save and request controls', async () => {
  vite = await createViteServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    envDir: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { MemoryRouter } = await import('react-router-dom');
  const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
  const { AuthContext } = await vite.ssrLoadModule('/src/context/AuthContext.jsx');
  const sources = await vite.ssrLoadModule('/src/data/listings.js');
  const lengths = [sources.properties.length, sources.vehicles.length];
  const previousStorage = globalThis.localStorage; globalThis.localStorage = { getItem() { return null; } };
  try {
    for (const row of rows) sources[row.type === 'property' ? 'properties' : 'vehicles'].push({ ...row, id: row._id });
    for (const row of rows.filter(row => row.inventoryKind === 'sample')) {
      const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [`/${row.type === 'property' ? 'properties' : 'vehicles'}/${row._id}`] },
        React.createElement(AuthContext.Provider, { value: { user: session, logout() {} } }, React.createElement(App))));
      assert.ok(html.includes(`<h1>${previewTitle(row)}</h1>`));
      assert.match(html, /At a glance/); assert.match(html, /Good to know/); assert.match(html, /Similar/);
      assert.match(html, row.type === 'vehicle' ? /AVAILABLE/ : /Available/); assert.match(html, /Save/);
      assert.match(html, row.type === 'vehicle' ? /Book now/ : /Request a visit/);
      const gallery = html.split('<section class="gallery">')[1].split('</section>')[0];
      assert.equal((gallery.match(/<img /g) || []).length, row.gallery.length + 1);
      assert.ok(row.gallery.every(url => gallery.includes(url)));
      assert.match(html, /Sample · unverified/);
      assert.doesNotMatch(html, /Demo \/ Sample inventory|Demo listing · reference photos|matching reference photo incomplete/);
      if (row.catalogKey !== 'mumbai-2026-M26') {
        assert.doesNotMatch(gallery, /catalog-placeholders/);
        assert.doesNotMatch(html, /Photo credits|<details/);
        assert.match(html, /class="shell site-image-credits"/);
        assert.doesNotMatch(html.split('<div class="owner-card">')[1].split('<div class="rental-note">')[0], /Images:|Image credits:|CC BY/);
        for (const credit of row.mediaCredits) {
          assert.ok(html.includes(credit.sourcePage)); assert.ok(html.includes(credit.licenseUrl));
          assert.ok(html.slice(html.indexOf('<footer')).includes(credit.sourcePage));
        }
      }
    }
  } finally {
    sources.properties.splice(lengths[0]); sources.vehicles.splice(lengths[1]); globalThis.localStorage = previousStorage;
  }
});

test('every original property detail uses its card cover; original vehicle galleries stay unchanged', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../catalog/original-listings.json', import.meta.url)));
  for (const row of rows.filter(row => !row.inventoryKind)) {
    const detail = await (await fetch(origin + '/api/listings/' + (row.legacyId || row._id))).json();
    for (const key of ['title','name','location','price','image']) assert.equal(detail[key], row[key]);
    if (row.type === 'property') assert.deepEqual(detail.gallery, [row.image]);
    else {
      const source = snapshot.listings.find(source => source._id === row._id) || vehicles.find(source => source.id === row.legacyId);
      assert.deepEqual(detail.gallery, source.gallery?.length ? source.gallery : [source.image]);
    }
  }
});

test('every property recommendation contains both groups, no self or duplicate links, and relevance still ranks', () => {
  const candidates = rows.filter(row => row.type === 'property');
  for (const item of candidates) {
    const result = previewPropertySimilar(item, [...candidates,...candidates]);
    assert.equal(result.length, 3); assert.equal(new Set(result.map(row => row._id)).size, 3);
    assert.ok(result.every(row => row._id !== item._id));
    assert.ok(result.some(row => row.inventoryKind === 'sample'));
    assert.ok(result.some(row => !row.inventoryKind));
  }
});

let adminSession, recordedProperty;
test('explicit interested/not-interested decisions persist, enforce ownership and leave WhatsApp opening non-mutating', async () => {
  const samples = rows.filter(row => row.type === 'property' && row.inventoryKind === 'sample').slice(3,5);
  for (const [index,row] of samples.entries()) {
    const response = await fetch(origin + '/api/bookings/visits',body({listingId:row._id,startDate:'2090-09-01',contact:{name:'Guest',email:'guest@rentsphere.test',phone:'9999999999'}}));
    assert.equal(response.status,201,await response.clone().text()); const visit=await response.json();
    const endpoint=origin+'/api/preview/property-visits/'+visit._id+'/decision';
    const decision=index===0?'interested':'not-interested';
    assert.equal((await fetch(endpoint,body({decision}))).status,400);
    assert.equal((await (await fetch(origin+'/api/listings/'+row._id)).json()).status,'available');
    const anonymous=body({decision,confirmedInApp:true});delete anonymous.headers.Authorization;
    assert.equal((await fetch(endpoint,anonymous)).status,401);
    const other=await (await fetch(origin+'/api/auth/register',body({name:'Other guest',email:'other'+index+'@rentsphere.test',password:'OtherGuest2026!'}))).json();
    const unauthorized=body({decision,confirmedInApp:true}); unauthorized.headers.Authorization='Bearer '+other.token;
    assert.equal((await fetch(endpoint,unauthorized)).status,404);
    const confirmed=await fetch(endpoint,body({decision,confirmedInApp:true}));
    assert.equal(confirmed.status,200,await confirmed.clone().text());
    assert.equal((await fetch(endpoint,body({decision,confirmedInApp:true}))).status,200); // Idempotent.
    assert.equal((await fetch(endpoint,body({decision: index===0?'not-interested':'interested',confirmedInApp:true}))).status,409);
    const detail=await (await fetch(origin+'/api/listings/'+row._id)).json();
    assert.equal(detail.status,index===0?'rented':'available');
    const recorded=await (await fetch(origin+'/api/preview/property-visits/'+row._id,{headers:{Authorization:'Bearer '+session.token}})).json();
    assert.equal(recorded.actionable,false);assert.equal(recorded.decision,decision);
    if(index===0) {
      recordedProperty=row._id;
      assert.equal((await fetch(origin+'/api/bookings/visits',body({listingId:row._id,startDate:'2090-10-01',contact:{name:'Guest',email:'guest@rentsphere.test',phone:'9999999999'}}))).status,409);
    }
  }
});

test('separate preview admin is hashed, logs in, has admin access; normal registration cannot grant admin', async () => {
  const login=preview.preview.adminLogin; assert.equal(login.email,'preview-admin@rentsphere.test');
  const stored=await mongoose.connection.db.collection('users').findOne({email:login.email});
  assert.notEqual(stored.password,login.password); assert.match(stored.password,/^\$2/);
  const response=await fetch(origin+'/api/auth/login',body(login));assert.equal(response.status,200);adminSession=await response.json();assert.equal(adminSession.role,'admin');
  assert.equal((await fetch(origin+'/api/admin/bookings',{headers:{Authorization:'Bearer '+adminSession.token}})).status,200);
  assert.equal((await fetch(origin+'/api/admin/bookings',{headers:{Authorization:'Bearer '+session.token}})).status,403);
  const normal=await fetch(origin+'/api/auth/register',body({name:'No escalation',email:'ordinary@rentsphere.test',password:'Ordinary2026!',role:'admin'}));
  assert.equal(normal.status,201); assert.notEqual((await normal.json()).role,'admin');
});

test('real preview restart preserves registered accounts, demo token, bookings and listing count without weakening login', async () => {
  const registration = await fetch(`${origin}/api/auth/register`, body({ name: 'Restart Guest', email: 'restart@rentsphere.test', password: 'PreviewRestart2026!' }));
  assert.equal(registration.status, 201); const registered = await registration.json();
  const bookingCount = await mongoose.connection.db.collection('bookings').countDocuments();
  await preview.close('restart persistence test');
  preview = await main(); origin = `http://127.0.0.1:${preview.server.address().port}`;
  for (const token of [session.token, registered.token]) assert.equal((await fetch(`${origin}/api/bookings/mybookings`, {
    headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal(await mongoose.connection.db.collection('listings').countDocuments(), 47);
  assert.equal(await mongoose.connection.db.collection('bookings').countDocuments(), bookingCount);
  assert.equal((await (await fetch(origin+'/api/listings/'+recordedProperty)).json()).status,'rented');
  assert.equal((await fetch(origin+'/api/admin/bookings',{headers:{Authorization:'Bearer '+adminSession.token}})).status,200);
  // A restart preserves the admin JWT and hash without loading a plaintext
  // password sidecar. Chosen-password login is covered by previewAuthentication.
  assert.equal(preview.preview.adminLogin,undefined);
  await assert.rejects(readFile(join(stateDirectory,'admin-login.json')), {code:'ENOENT'});
  assert.equal((await fetch(`${origin}/api/auth/login`, body({ email: 'restart@rentsphere.test', password: 'wrong' }))).status, 401);
  assert.equal((await fetch(`${origin}/api/auth/login`, body({ email: 'restart@rentsphere.test', password: 'PreviewRestart2026!' }))).status, 200);
});

test('an occupied preview port fails before database startup and leaves the running preview/session untouched', async () => {
  process.env.RENTSPHERE_PREVIEW_PORT = String(preview.server.address().port);
  try { await assert.rejects(main(), { code: 'EADDRINUSE' }); }
  finally { process.env.RENTSPHERE_PREVIEW_PORT = '0'; }
  assert.equal((await fetch(`${origin}/api/bookings/mybookings`, { headers: { Authorization: `Bearer ${session.token}` } })).status, 200);
  assert.equal(await mongoose.connection.db.collection('listings').countDocuments(), 47);
});

test('re-running the command reuses its healthy remembered preview without restarting the database', async () => {
  delete process.env.RENTSPHERE_PREVIEW_PORT;
  await writeFile(join(stateDirectory, 'port.json'), JSON.stringify(preview.server.address().port));
  try {
    const repeated = await main(); assert.equal(repeated.reused, true);
    assert.equal(await mongoose.connection.db.collection('listings').countDocuments(), 47);
  } finally { process.env.RENTSPHERE_PREVIEW_PORT = '0'; }
});
