import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import User from '../models/User.js';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';
import DeliveryQuote from '../models/DeliveryQuote.js';
import listings from '../routes/listings.js';
import bookings from '../routes/bookings.js';
import adminRoutes from '../routes/admin.js';
import { generateToken } from '../utils/tokens.js';
import { deliveryArea, boundaryPolygons, withinArea, deliveryAmounts, drivingDistance, validateDeliveryLocations } from '../utils/deliveryQuotes.js';
import { hostingFixture } from './helpers/hostingFixture.js';
import { configureDeliveryQuotes, testPickup, testDestination } from './helpers/deliveryQuoteFixture.js';
import { vehicleBookingMessage } from '../../src/data/vehicleBookingMessage.js';
import { vehicleBookingDetails } from '../../src/data/vehicleBookingDetails.js';

process.env.JWT_SECRET = randomBytes(48).toString('hex');
let mongo, server, origin, owner, customer, stranger, admin, app;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: join(tmpdir(), 'rentsphere-test-mongodb') }, replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { dbName: 'delivery_quotes_disposable_' + randomUUID().replaceAll('-', '') });
  await Promise.all([User.init(), Listing.init(), Booking.init(), DeliveryQuote.init()]);
  [owner, customer, stranger, admin] = await Promise.all(['owner','user','user','admin'].map(role => User.create({ name: 'Disposable delivery fixture', email: randomUUID() + '@example.test', password: 'DisposableChosenPassword!', role, ...(role === 'owner' ? { ownerProfile: { status: 'approved', listingIntent: 'both' } } : {}) })));
  app = express(); app.use(express.json()); configureDeliveryQuotes(app);
  app.use('/api/listings', listings); app.use('/api/bookings', bookings); app.use('/api/admin', adminRoutes);
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  origin = 'http://127.0.0.1:' + server.address().port;
}, { timeout: 180000 });
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo?.stop(); });
async function request(path, body, actor = customer, method = 'POST') {
  const response = await fetch(origin + path, { method, headers: { 'Content-Type':'application/json', ...(actor ? { Authorization:'Bearer ' + generateToken(actor._id) } : {}) }, ...(body ? { body:JSON.stringify(body) } : {}) });
  return { status:response.status, data:await response.json() };
}
const vehicle = extra => Listing.create({ ...hostingFixture('vehicle'), locationCoordinates:testPickup, host:owner._id, ...extra });
const details = listing => ({ listingId:String(listing._id), startDate:'2099-11-10', endDate:'2099-11-12', deliveryAddress:'Customer reviewed address', deliveryCoordinates:testDestination });
const quoteFor = (body, actor) => request('/api/bookings/delivery-quote', body, actor);
const save = (body, quote) => request('/api/bookings', { ...body, fulfilment:'delivery', deliveryQuoteId:quote?.quoteId });
const routeResponse = distance => ({ ok:true, status:200, json:async()=>({features:[{properties:{mode:'drive', units:'metric', distance}}]}) });
const customFile = fileURLToPath(new URL('../config/delivery-service-area.geojson', import.meta.url));
const customEnv = { MUMBAI_DELIVERY_BOUNDARY_FILE: customFile, MUMBAI_DELIVERY_BOUNDARY_SOURCE: 'custom:delivery-service-area.sources.json' };
// Derive test pins from supplied polygon interiors. These pins never define or extend the service area.
function interiorPin(feature) {
  const polygons = boundaryPolygons(feature);
  for (const polygon of polygons) {
    const ring = polygon[0], lat = (Math.min(...ring.map(p => p[1])) + Math.max(...ring.map(p => p[1]))) / 2;
    const intersections = [];
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i];
      if ((a[1] > lat) !== (b[1] > lat)) intersections.push(a[0] + (lat - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 1; i < intersections.length; i += 2) {
      const pin = { lat, lon: (intersections[i - 1] + intersections[i]) / 2 };
      if (withinArea(pin, polygons)) return pin;
    }
  }
  throw new Error('Source polygon has no usable test interior');
}

test('expanded custom area preserves every original feature, documents valid repairs and rejects damaged or undocumented geometry', async () => {
  const area = await deliveryArea(customEnv);
  const collection = JSON.parse(await readFile(customFile, 'utf8'));
  const manifestText = await readFile(new URL('../config/delivery-service-area.sources.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.enabledAreaIds, ['mumbai', 'navi-mumbai', 'mira-bhayandar', 'thane', 'kalyan-dombivli', 'vasai-virar', 'bhiwandi', 'panvel', 'ulhasnagar', 'ambernath', 'kulgaon-badlapur']);
  assert.equal(collection.features.length, 312);
  // Golden digests captured before this expansion: all 194 previously enabled features remain byte-equivalent after JSON parsing.
  const previousAreaDigests = {"mumbai":"180e8c844929174e44ec996a7fc88aedb11b0ea0fcfca9413665ba348305f39b","thane":"469cc9f59c9258df2c834dd0521b8c2efec8a4d774a0a62fb2782ca30086838a","kalyan-dombivli":"be82868696f10ecb6b985ffa4bce75775080cc7bce9c71a9405b31326c89ac66"};
  for (const [id, digest] of Object.entries(previousAreaDigests)) assert.equal(createHash('sha256').update(JSON.stringify(collection.features.filter(row => row.properties.areaId === id))).digest('hex'), digest);
  assert.equal(manifest.preservationVerification.lostPriorCoverageSquareDegrees, 0);
  for (const id of ['navi-mumbai', 'mira-bhayandar']) {
    const source = manifest.sources.find(row => row.id === id);
    assert.equal(source.validation.allFeaturesValid, true);
    assert.equal(source.validation.repairCount, id === 'navi-mumbai' ? 11 : 1);
    for (const repair of source.validation.repairs) assert.ok(repair.verifiedSourceFootprintDifferenceSquareDegrees <= 1e-14);
  }
  for (const source of manifest.sources.filter(row => row.osmRelationId)) {
    assert.equal(source.scopeTags.admin_level, '8'); assert.equal(source.scopeTags.boundary, 'administrative');
    assert.match(source.license, /ODbL/);
  }
  for (const feature of collection.features) assert.ok(manifest.enabledAreaIds.includes(feature.properties.areaId));
  const directory = await mkdtemp(join(tmpdir(), 'rentsphere-boundary-validation-'));
  const file = join(directory, 'delivery-service-area.geojson'), sourceFile = join(directory, 'delivery-service-area.sources.json');
  const env = { ...customEnv, MUMBAI_DELIVERY_BOUNDARY_FILE: file };
  try {
    const original = await readFile(customFile, 'utf8');
    await writeFile(file, original); await writeFile(sourceFile, manifestText);
    assert.equal((await deliveryArea(env)).version, area.version);
    await writeFile(file, original + ' ');
    await assert.rejects(deliveryArea(env), error => error.code === 'SERVICE_AREA_UNCONFIGURED');
    await writeFile(file, original);
    await writeFile(sourceFile, JSON.stringify({ ...manifest, enabledAreaIds: [...manifest.enabledAreaIds, 'unsupported-area'] }));
    await assert.rejects(deliveryArea(env), error => error.code === 'SERVICE_AREA_UNCONFIGURED');
    await writeFile(sourceFile, JSON.stringify({ ...manifest, sources: manifest.sources.map(row => ({ ...row, license: '' })) }));
    await assert.rejects(deliveryArea(env), error => error.code === 'SERVICE_AREA_UNCONFIGURED');
    await writeFile(sourceFile, manifestText);
    await assert.rejects(deliveryArea({ ...env, MUMBAI_DELIVERY_BOUNDARY_SOURCE: 'custom:unknown.json' }), error => error.code === 'SERVICE_AREA_UNCONFIGURED');
    await rm(sourceFile);
    await assert.rejects(deliveryArea(env), error => error.code === 'SERVICE_AREA_UNCONFIGURED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real packaged footprints allow included-area and cross-area quotes only, preserving pricing, fallback, acceptance and pickup', async () => {
  const area = await deliveryArea(customEnv), collection = JSON.parse(await readFile(customFile, 'utf8'));
  const ids = JSON.parse(await readFile(new URL('../config/delivery-service-area.sources.json', import.meta.url), 'utf8')).enabledAreaIds;
  const rows = ids.map(id => ({ id, feature: collection.features.find(row => row.properties.areaId === id) }));
  const pins = rows.map(row => interiorPin(row.feature));
  const suburban = interiorPin(collection.features.find(row => row.properties.areaId === 'mumbai' && row.properties.sourceFeatureId === '11')); // BMC R/C; first Mumbai feature is A ward.
  for (const pin of [...pins, suburban]) assert.equal(withinArea(pin, area.polygons), true);
  configureDeliveryQuotes(app, { area: async () => area });
  for (let i = 0; i < rows.length; i++) {
    const listing = await vehicle({ locationCoordinates: pins[i] });
    const body = { ...details(listing), deliveryCoordinates: pins[i] };
    assert.equal((await quoteFor(body)).status, 200, rows[i].id + ' same-area quote');
    const destination = i === 0 ? suburban : pins[(i + 1) % pins.length];
    const cross = { ...body, deliveryCoordinates: destination };
    const quoted = await quoteFor(cross); assert.equal(quoted.status, 200, rows[i].id + ' cross-area quote');
    assert.equal(quoted.data.distanceMeters, 12400); assert.equal(quoted.data.deliveryCharge, 445);
    const booking = await save(cross, quoted.data); assert.equal(booking.status, 201); assert.equal(booking.data.totalPrice, 2845);
    const accepted = await request('/api/bookings/' + booking.data._id + '/confirm', null, owner, 'PUT');
    assert.equal(accepted.status, 200); assert.equal(accepted.data.totalPrice, 2845);
  }
  // Previously excluded interior samples must now work without losing existing Mumbai/Thane/KDMC coverage.
  const expandedSamples = [
    { lat: 19.2781825, lon: 72.85581352410249 }, { lat: 19.186537705151064, lon: 73.00288111685461 },
    { lat: 19.293412588520148, lon: 73.06600487386592 }, { lat: 19.40756278039805, lon: 72.85659270392867 },
    { lat: 19.000053022579, lon: 73.10808687996294 },
  ];
  for (const pin of expandedSamples) assert.equal(withinArea(pin, area.polygons), true);
  const outside = [{ lat: 0, lon: 0 }, { lat: 18.5204, lon: 73.8567 }, { lat: 28.6139, lon: 77.209 }, { lat: 20, lon: 73 }];
  const listing = await vehicle({ locationCoordinates: pins[0] }), body = { ...details(listing), deliveryCoordinates: pins[1] };
  for (const pin of outside) {
    assert.equal(withinArea(pin, area.polygons), false);
    const result = await quoteFor({ ...body, deliveryCoordinates: pin, fallback: true });
    assert.equal(result.status, 422); assert.equal(result.data.code, 'OUTSIDE_SERVICE_AREA'); assert.equal(result.data.fallbackAllowed, false);
    assert.throws(() => validateDeliveryLocations({ locationCoordinates: pin }, pins[0], area), error => error.code === 'OUTSIDE_SERVICE_AREA');
  }
  for (const pin of [undefined, null, { lat: 91, lon: 72 }, { lat: 19, lon: '73' }]) assert.equal((await quoteFor({ ...body, deliveryCoordinates: pin })).status, 400);
  const edge = rows[0].feature.geometry.coordinates[0][0];
  const edgePoint = rows[0].feature.geometry.type === 'Polygon' ? edge : rows[0].feature.geometry.coordinates[0][0][0];
  assert.equal(withinArea({ lon: edgePoint[0], lat: edgePoint[1] }, area.polygons), true);
  configureDeliveryQuotes(app, { area: async () => area, send: async () => { throw new Error('Disposable routing outage'); } });
  assert.equal((await quoteFor(body)).data.fallbackAllowed, false); assert.equal((await quoteFor(body)).data.fallbackAllowed, true);
  const fallback = await quoteFor({ ...body, fallback: true }); assert.equal(fallback.status, 200); assert.equal(fallback.data.deliveryCharge, 300);
  assert.equal(fallback.data.distanceMeters, undefined); assert.equal((await save(body, fallback.data)).status, 201);
  const pickup = await request('/api/bookings', { listingId: String(listing._id), startDate: '2099-12-10', endDate: '2099-12-12', fulfilment: 'pickup' });
  assert.equal(pickup.status, 201); assert.equal(pickup.data.deliveryCharge, 0);
  configureDeliveryQuotes(app);
});

test('college pickup supports Kalyan West/East and Dombivli East/West through the real quote endpoint without any city-name bypass', async () => {
  const area = await deliveryArea(customEnv);
  const manifest = JSON.parse(await readFile(new URL('../config/delivery-service-area.sources.json', import.meta.url), 'utf8'));
  const [college, ...destinations] = manifest.regressionSamples;
  assert.equal(college.name, 'Government Polytechnic Mumbai');
  assert.deepEqual(destinations.map(row => row.name), ['Kalyan West', 'Kalyan East', 'Dombivli East', 'Dombivli West']);
  configureDeliveryQuotes(app, { area: async () => area });
  const listing = await vehicle({ locationCoordinates: college.pin });
  for (const destination of destinations) {
    assert.equal(destination.insidePreviousCoverage, true);
    assert.equal(withinArea(college.pin, area.polygons), true);
    assert.equal(withinArea(destination.pin, area.polygons), true);
    const result = await quoteFor({ ...details(listing), deliveryAddress: destination.name, deliveryCoordinates: destination.pin });
    assert.equal(result.status, 200, destination.name + ': ' + JSON.stringify(result.data));
    assert.equal(result.data.deliveryCharge, 445); assert.equal(result.data.totalPrice, 2845);
    assert.deepEqual(result.data.pickupCoordinates, college.pin); assert.deepEqual(result.data.deliveryCoordinates, destination.pin);
  }
  const outsidePickup = await vehicle({ locationCoordinates: { lat: 18.5204, lon: 73.8567 } });
  const denied = await quoteFor({ ...details(outsidePickup), deliveryAddress: 'Kalyan West', deliveryCoordinates: destinations[0].pin, pickupCoordinates: college.pin });
  assert.equal(denied.status, 422); assert.equal(denied.data.code, 'OUTSIDE_SERVICE_AREA'); assert.match(denied.data.message, /pickup/);
  configureDeliveryQuotes(app);
});

test('approved-area geometry supports polygons, holes and multipolygons; missing configuration fails closed', async () => {
  const shape = { type:'Polygon', coordinates:[[[72,18],[74,18],[74,20],[72,20],[72,18]],[[72.2,18.2],[72.4,18.2],[72.4,18.4],[72.2,18.4],[72.2,18.2]]] };
  const polygons=boundaryPolygons(shape);
  assert.equal(withinArea(testPickup,polygons),true); assert.equal(withinArea({lat:18.3,lon:72.3},polygons),false); assert.equal(withinArea({lat:30,lon:70},polygons),false);
  assert.equal(boundaryPolygons({type:'MultiPolygon',coordinates:[shape.coordinates]}).length,1);
  assert.throws(()=>boundaryPolygons({type:'Point',coordinates:[72,19]}));
  await assert.rejects(deliveryArea({}), error=>error.code==='SERVICE_AREA_UNCONFIGURED');
});
test('road pricing uses ceil kilometres and integer delivery rupees; routing sends lat,lon in driving mode', async () => {
  assert.deepEqual(deliveryAmounts(12400),{distanceMeters:12400,billableKm:13,deliveryCharge:445});
  assert.equal(deliveryAmounts(12000).deliveryCharge,420); assert.equal(deliveryAmounts(0).deliveryCharge,120);
  for(const invalid of [-1,NaN,Infinity,'12400']) assert.throws(()=>deliveryAmounts(invalid));
  const result=await drivingDistance(testPickup,testDestination,{env:{GEOAPIFY_API_KEY:'mock-only'},send:async url=>{
    const parsed=new URL(url); assert.equal(parsed.searchParams.get('waypoints'),'19.07,72.87|19.08,72.88'); assert.equal(parsed.searchParams.get('mode'),'drive'); return routeResponse(12400);
  }});
  assert.equal(result.deliveryCharge,445);
  await assert.rejects(drivingDistance({lat:91,lon:72},testDestination,{env:{}}),/Coordinates/);
});
test('routing sanitizes timeout, quota, network and malformed responses; known no-route and configuration failures cannot offer fallback',async()=>{
  for(const send of [async()=>{throw new Error('apiKey=private-test-value');},async()=>({ok:false,status:429}),async()=>({ok:true,status:200,json:async()=>({bad:true})}),async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('Timeout'),{name:'AbortError'}))))]) {
    await assert.rejects(drivingDistance(testPickup,testDestination,{env:{GEOAPIFY_API_KEY:'mock-only'},send,timeout:5}),error=>{assert.equal(error.code,'ROUTING_TEMPORARY');assert.doesNotMatch(error.message,/private-test-value|apiKey/);return true;});
  }
  await assert.rejects(drivingDistance(testPickup,testDestination,{env:{GEOAPIFY_API_KEY:'mock-only'},send:async()=>({ok:true,status:200,json:async()=>({features:[]})})}),error=>error.code==='NO_DRIVING_ROUTE');
  await assert.rejects(drivingDistance(testPickup,testDestination,{env:{}}),error=>error.code==='ROUTING_UNCONFIGURED');
});
test('real quote and booking endpoints reject tampering, preserve reviewed amounts at owner/admin acceptance and keep dates blocked',async()=>{
  for(const actor of [owner,admin]) {
    configureDeliveryQuotes(app); const listing=await vehicle(), body=details(listing), quote=await quoteFor({...body,deliveryCharge:1,distanceMeters:1,pickupCoordinates:{lat:0,lon:0}});
    assert.equal(quote.status,200,JSON.stringify(quote.data)); assert.equal(quote.data.deliveryCharge,445); assert.equal(quote.data.totalPrice,2845);
    assert.deepEqual(quote.data.pickupCoordinates,testPickup);
    const created=await request('/api/bookings',{...body,fulfilment:'delivery',deliveryQuoteId:quote.data.quoteId,totalPrice:1,deliveryCharge:1,deliveryQuote:{kind:'estimated'}});
    assert.equal(created.status,201,JSON.stringify(created.data)); assert.equal(created.data.totalPrice,2845); assert.equal(created.data.deliveryCharge,445); assert.equal(created.data.deliveryQuote.kind,'calculated');
    assert.equal((await save(body,quote.data)).status,409);
    await Listing.updateOne({_id:listing._id},{$set:{price:2000,locationCoordinates:{lat:19.09,lon:72.89}}});
    const accepted=await request('/api/bookings/'+created.data._id+'/confirm',null,actor,'PUT');
    assert.equal(accepted.status,200); assert.equal(accepted.data.totalPrice,2845); assert.equal(accepted.data.deliveryCharge,445); assert.deepEqual(accepted.data.deliveryQuote,created.data.deliveryQuote);
    const calendar=await request('/api/listings/'+listing._id+'/availability?from=2099-11-10&to=2099-11-12',null,null,'GET'); assert.equal(calendar.data.bookedRanges.length,1);
    const notices=await request('/api/bookings/notifications',null,customer,'GET'); assert.ok(notices.data.some(row=>row._id===created.data._id&&row.status==='confirmed'));
  }
});
test('Phase 3 persists server vehicle snapshots, exposes saved quote details to owner/admin and formats the actual saved booking', async () => {
  configureDeliveryQuotes(app);
  for (const fulfilment of ['pickup', 'delivery']) {
    const listing = await vehicle(), body = details(listing), contact = { name: 'Saved API Customer', email: 'dashboard-only@example.test', phone: '9876543210' };
    const quote = fulfilment === 'delivery' ? (await quoteFor(body)).data : null;
    const created = await request('/api/bookings', { ...body, deliveryCoordinates: fulfilment === 'delivery' ? body.deliveryCoordinates : undefined,
      fulfilment, contact, deliveryQuoteId: quote?.quoteId, vehicleSnapshot: { name: 'Forged vehicle', pickupAddress: 'Forged address', pickupCoordinates: { lat: 0, lon: 0 } } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.deepEqual(created.data.vehicleSnapshot, { name: listing.title || listing.name, pickupAddress: listing.location, pickupCoordinates: testPickup });
    const message = vehicleBookingMessage({ booking: created.data });
    assert.ok(message.includes('*Pickup Address:* ' + listing.location)); assert.doesNotMatch(message, /dashboard-only@example.test|Email:|Forged/);
    assert.ok(message.includes('*Total Amount:* ₹' + (fulfilment === 'delivery' ? '2,845' : '2,400')));
    if (fulfilment === 'delivery') assert.match(message, /\*Road Distance:\* 12\.40 km/);
    else assert.doesNotMatch(message, /Road Distance|Delivery Address/);
    await Listing.updateOne({ _id: listing._id }, { $set: { title: 'Changed current title', location: 'Changed current pickup', locationCoordinates: { lat: 19.15, lon: 72.95 } } });
    for (const [path, actor] of [['/api/bookings/owner/requests', owner], ['/api/admin/requests?type=vehicle', admin]]) {
      const result = await request(path, null, actor, 'GET'); assert.equal(result.status, 200);
      const row = result.data.find(value => value._id === created.data._id); assert.ok(row);
      assert.deepEqual(row.vehicleSnapshot, created.data.vehicleSnapshot); assert.deepEqual(row.deliveryQuote, created.data.deliveryQuote);
      const shown = vehicleBookingDetails(row); assert.equal(shown.pickupAddress, listing.location); assert.equal(shown.name, listing.title || listing.name);
      assert.ok(fulfilment === 'delivery' ? shown.routeUrl : shown.locationUrl);
    }
    assert.equal((await request('/api/admin/requests?type=vehicle', null, customer, 'GET')).status, 403);
    const accepted = await request('/api/bookings/' + created.data._id + '/confirm', null, owner, 'PUT');
    assert.equal(accepted.status, 200); assert.equal(accepted.data.totalPrice, created.data.totalPrice); assert.deepEqual(accepted.data.vehicleSnapshot, created.data.vehicleSnapshot);
    const mine = await request('/api/bookings/mybookings', null, stranger, 'GET'); assert.ok(mine.data.every(row => row._id !== created.data._id));
  }
});

test('quotes reject stale location, address, dates, pricing, user, expired references and replaced quote versions',async()=>{
  configureDeliveryQuotes(app);const listing=await vehicle(),body=details(listing),quote=(await quoteFor(body)).data;
  for(const change of [{deliveryAddress:'Different address'},{deliveryCoordinates:{lat:19.1,lon:72.9}},{startDate:'2099-11-11'}]) assert.equal((await save({...body,...change},quote)).status,409);
  assert.equal((await request('/api/bookings',{...body,fulfilment:'delivery',deliveryQuoteId:quote.quoteId},stranger)).status,409);
  await Listing.updateOne({_id:listing._id},{$set:{price:1300}}); assert.equal((await save(body,quote)).status,409);
  await Listing.updateOne({_id:listing._id},{$set:{price:1200,locationCoordinates:{lat:19.1,lon:72.9}}}); assert.equal((await save(body,quote)).status,409);
  await Listing.updateOne({_id:listing._id},{$set:{locationCoordinates:testPickup}});
  configureDeliveryQuotes(app,{send:async()=>routeResponse(14500)}); const revised=await quoteFor(body);assert.equal(revised.status,200);assert.notEqual(revised.data.quoteId,quote.quoteId);assert.equal((await save(body,quote)).status,409);
  await DeliveryQuote.updateOne({_id:revised.data.quoteId.split('.')[0]},{$set:{expiresAt:new Date(0)}});assert.equal((await save(body,revised.data)).status,409);
});
test('retry then explicit fallback stores a distance-free estimate and acceptance never resolves it automatically',async()=>{
  configureDeliveryQuotes(app,{send:async()=>{throw new Error('Mock network failure');}}); const listing=await vehicle(),body=details(listing);
  assert.equal((await quoteFor({...body,fallback:true})).status,409);
  const first=await quoteFor(body);assert.equal(first.status,503);assert.equal(first.data.fallbackAllowed,false);
  assert.equal((await quoteFor({...body,fallback:true})).status,409);
  const second=await quoteFor(body);assert.equal(second.data.fallbackAllowed,true);
  const estimate=await quoteFor({...body,fallback:true});assert.equal(estimate.status,200);assert.equal(estimate.data.kind,'estimated');assert.equal(estimate.data.deliveryCharge,300);assert.equal(estimate.data.distanceMeters,undefined);assert.equal(estimate.data.billableKm,undefined);
  const created=await save(body,estimate.data);assert.equal(created.status,201);
  const accepted=await request('/api/bookings/'+created.data._id+'/confirm',null,owner,'PUT');assert.equal(accepted.status,200);assert.equal(accepted.data.totalPrice,2700);assert.equal(accepted.data.deliveryQuote.kind,'estimated');assert.equal(accepted.data.deliveryCharge,300);
});
test('invalid, missing and out-of-area locations and known no-route results never permit fallback; configuration gates only delivery',async()=>{
  configureDeliveryQuotes(app);const listing=await vehicle(),body=details(listing);
  assert.equal((await quoteFor({...body,deliveryCoordinates:{lat:91,lon:72},fallback:true})).status,400);
  assert.equal((await quoteFor({...body,deliveryCoordinates:{lat:22,lon:72},fallback:true})).status,422);
  const legacy=await vehicle({locationCoordinates:undefined}); assert.equal((await quoteFor({...details(legacy),fallback:true})).data.code,'PICKUP_LOCATION_MISSING');
  const outside=await vehicle({locationCoordinates:{lat:22,lon:72}});assert.equal((await quoteFor(details(outside))).status,422);
  configureDeliveryQuotes(app,{send:async()=>({ok:true,status:200,json:async()=>({features:[]})})});assert.equal((await quoteFor(body)).data.code,'NO_DRIVING_ROUTE');
  configureDeliveryQuotes(app,{send:async()=>{throw new Error('Network');}});await quoteFor(body);await quoteFor(body);assert.equal((await quoteFor({...body,fallback:true})).status,409);
  app.locals.deliveryQuoteServices={};const blocked=await quoteFor(body);assert.equal(blocked.status,503);assert.equal(blocked.data.code,'SERVICE_AREA_UNCONFIGURED');assert.equal(blocked.data.fallbackAllowed,false);
  assert.equal((await request('/api/bookings',{listingId:String(legacy._id),startDate:'2099-12-10',endDate:'2099-12-12',fulfilment:'pickup'})).status,201);
  assert.equal((await save(body,null)).status,400);
});
test('quote authentication, concurrent route requests and old booking charges remain safe',async()=>{
  let finish,calls=0;configureDeliveryQuotes(app,{send:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});const listing=await vehicle(),body=details(listing);
  assert.equal((await quoteFor(body,null)).status,401);
  const first=quoteFor(body);for(let i=0;i<100&&!finish;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(finish);
  const duplicate=await quoteFor(body);assert.equal(duplicate.status,409);assert.equal(calls,1);finish(routeResponse(12400));assert.equal((await first).status,200);
  const legacy=await Booking.create({user:customer._id,listing:listing._id,status:'pending',requestType:'vehicle',startDate:'2099-12-20',endDate:'2099-12-22',fulfilment:'delivery',deliveryAddress:'Historical address',deliveryCharge:300,totalPrice:2700});
  const accepted=await request('/api/bookings/'+legacy._id+'/confirm',null,owner,'PUT');assert.equal(accepted.status,200);assert.equal(accepted.data.totalPrice,2700);assert.equal(accepted.data.deliveryQuote,undefined);
});
