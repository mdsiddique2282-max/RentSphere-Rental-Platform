import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { coordinateValue } from '../../src/data/coordinates.js';
import DeliveryQuote from '../models/DeliveryQuote.js';

export const deliveryError = (status, code, message) => Object.assign(new Error(message), { status, code });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function boundaryPolygons(value) {
  const geometries = value?.type === 'FeatureCollection' ? value.features?.map(feature => feature.geometry) : [value?.type === 'Feature' ? value.geometry : value];
  if (!Array.isArray(geometries) || !geometries.length) throw new Error('Missing polygon');
  const polygons = geometries.flatMap(geometry => geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : []);
  if (!polygons.length || geometries.some(geometry => !['Polygon', 'MultiPolygon'].includes(geometry?.type))) throw new Error('Invalid polygon');
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) throw new Error('Invalid polygon');
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4 || ring.some(p => !Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) || JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))) throw new Error('Invalid ring');
    }
  }
  return polygons;
}
function inRing({ lat: y, lon: x }, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (Math.abs((x - xi) * (yj - yi) - (y - yi) * (xj - xi)) < 1e-12 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function withinArea(point, polygons) { return polygons.some(polygon => inRing(point, polygon[0]) && !polygon.slice(1).some(hole => inRing(point, hole))); }
export async function deliveryArea(env = process.env) {
  try {
    const file = env.MUMBAI_DELIVERY_BOUNDARY_FILE, source = env.MUMBAI_DELIVERY_BOUNDARY_SOURCE;
    if (!file) throw new Error('Not configured');
    const content = await readFile(file, 'utf8'), geojson = JSON.parse(content);
    let provenance = source;
    if (source === 'custom:delivery-service-area.sources.json') {
      // A local, documented custom area must match its geometry digest and declared source footprints.
      const manifest = JSON.parse(await readFile(resolve(dirname(file), 'delivery-service-area.sources.json'), 'utf8'));
      if (manifest.schemaVersion !== 1 || manifest.name !== 'RentSphere Delivery Service Area' ||
          manifest.datasetFile !== 'delivery-service-area.geojson' || geojson.type !== 'FeatureCollection' ||
          createHash('sha256').update(content).digest('hex') !== manifest.datasetSha256 ||
          !Array.isArray(manifest.enabledAreaIds) || !manifest.enabledAreaIds.length ||
          new Set(manifest.enabledAreaIds).size !== manifest.enabledAreaIds.length || !Array.isArray(manifest.sources)) throw new Error('Invalid custom provenance');
      const enabled = manifest.sources.filter(row => row.status === 'enabled');
      if (enabled.length !== manifest.enabledAreaIds.length || enabled.some(row =>
        !manifest.enabledAreaIds.includes(row.id) || !/^https:\/\//.test(row.url || '') || !row.license || !row.attribution ||
        !/^https:\/\//.test(row.licenseUrl || '') || row.validation?.errors?.length !== 0 ||
        !Number.isInteger(row.featureCount) || row.featureCount < 1 ||
        geojson.features.filter(feature => feature.properties?.areaId === row.id).length !== row.featureCount) ||
        geojson.features.some(feature => !enabled.some(row => row.id === feature.properties?.areaId))) throw new Error('Undocumented custom footprint');
      provenance = [source, manifest];
    } else if (!/^https:\/\//.test(source || '')) throw new Error('Missing source');
    return { polygons: boundaryPolygons(geojson), version: hash([geojson, provenance]) };
  } catch { throw deliveryError(503, 'SERVICE_AREA_UNCONFIGURED', 'Home Delivery is unavailable until a validated RentSphere Delivery Service Area is configured. Self Pickup is still available.'); }
}
export function deliveryAmounts(meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) throw deliveryError(503, 'ROUTING_TEMPORARY', 'The route response did not contain a valid road distance.');
  const billableKm = Math.ceil(meters / 1000), charge = 120 + billableKm * 25;
  if (!Number.isSafeInteger(charge)) throw deliveryError(503, 'ROUTING_TEMPORARY', 'The road distance cannot be priced safely.');
  return { distanceMeters: meters, billableKm, deliveryCharge: charge };
}
export async function drivingDistance(from, to, { env = process.env, send = fetch, timeout = 10000 } = {}) {
  coordinateValue(from); coordinateValue(to);
  if (!env.GEOAPIFY_API_KEY) throw deliveryError(503, 'ROUTING_UNCONFIGURED', 'Home Delivery routing is not configured. Self Pickup is still available.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const url = new URL('https://api.geoapify.com/v1/routing');
    url.searchParams.set('waypoints', `${from.lat},${from.lon}|${to.lat},${to.lon}`);
    url.searchParams.set('mode', 'drive'); url.searchParams.set('units', 'metric'); url.searchParams.set('apiKey', env.GEOAPIFY_API_KEY);
    const response = await send(url.toString(), { signal: controller.signal });
    if ([400, 404, 422].includes(response.status)) throw deliveryError(422, 'NO_DRIVING_ROUTE', 'No driving route is available for these locations. Choose another location or Self Pickup.');
    if ([401, 403].includes(response.status)) throw deliveryError(503, 'ROUTING_UNCONFIGURED', 'Home Delivery routing is unavailable. Self Pickup is still available.');
    if (!response.ok) throw new Error('Provider unavailable');
    const data = await response.json();
    if (Array.isArray(data.features) && data.features.length === 0) throw deliveryError(422, 'NO_DRIVING_ROUTE', 'No driving route is available for these locations. Choose another location or Self Pickup.');
    const route = data.features?.[0]?.properties;
    if (!route || (route.mode && route.mode !== 'drive') || (route.units && route.units !== 'metric')) throw new Error('Invalid route');
    return deliveryAmounts(route.distance);
  } catch (error) {
    if (error.code && error.status) throw error;
    throw deliveryError(503, 'ROUTING_TEMPORARY', 'Road distance could not be calculated. Please retry the calculation.');
  } finally { clearTimeout(timer); }
}
export function quoteBinding({ userId, listing, dates, destination, address, area }) {
  return hash([String(userId), String(listing._id), coordinateValue(listing.locationCoordinates), listing.location, listing.price,
    dates.start.toISOString(), dates.end.toISOString(), coordinateValue(destination), address.trim(), area.version]);
}
export function validateDeliveryLocations(listing, destination, area) {
  if (!listing.locationCoordinates) throw deliveryError(400, 'PICKUP_LOCATION_MISSING', 'This vehicle has no confirmed map location. Its owner/admin must select a pickup location before Home Delivery can be quoted. Self Pickup remains available.');
  const pickup = coordinateValue(listing.locationCoordinates); coordinateValue(destination);
  if (!destination) throw deliveryError(400, 'DELIVERY_LOCATION_REQUIRED', 'Select a valid delivery location.');
  if (!withinArea(pickup, area.polygons)) throw deliveryError(422, 'OUTSIDE_SERVICE_AREA', 'The vehicle pickup location is outside the configured RentSphere Delivery Service Area. Self Pickup remains available.');
  if (!withinArea(destination, area.polygons)) throw deliveryError(422, 'OUTSIDE_SERVICE_AREA', 'The delivery location is outside the configured RentSphere Delivery Service Area. Choose another confirmed location or Self Pickup.');
}
export async function createDeliveryQuote({ userId, listing, dates, destination, address, fallback, env, area, send, timeout }) {
  validateDeliveryLocations(listing, destination, area);
  if (!Number.isFinite(listing.price) || listing.price < 0) throw deliveryError(400, 'INVALID_PRICE', 'This listing does not have a valid rental price.');
  const binding = quoteBinding({ userId, listing, dates, destination, address, area }), now = new Date();
  await DeliveryQuote.init();
  await DeliveryQuote.updateOne({ binding }, { $setOnInsert: { binding, user: userId, listing: listing._id, expiresAt: new Date(+now + 600000), attempts: 0, state: 'new', noRoute: false } }, { upsert: true });
  // Expired records can remain briefly before MongoDB's TTL cleanup.
  await DeliveryQuote.updateOne({ binding, expiresAt: { $lte: now }, $or: [{ busyUntil: { $exists: false } }, { busyUntil: { $lte: now } }] },
    { $set: { expiresAt: new Date(+now + 600000), attempts: 0, state: 'new', noRoute: false }, $unset: { quote: '' } });
  const record = await DeliveryQuote.findOneAndUpdate({ binding, expiresAt: { $gt: now }, $or: [{ busyUntil: { $exists: false } }, { busyUntil: { $lte: now } }] },
    { $set: { busyUntil: new Date(+now + 20000) } }, { returnDocument: 'after' });
  if (!record) throw deliveryError(409, 'QUOTE_BUSY', 'A delivery calculation is already in progress. Please wait and retry.');
  try {
    let amounts;
    if (fallback) {
      if (record.state !== 'temporary' || record.attempts < 2 || record.noRoute) throw deliveryError(409, 'FALLBACK_NOT_ALLOWED', 'Retry the route calculation before selecting an estimated charge. Fallback is not available for invalid locations or known unavailable routes.');
      amounts = { deliveryCharge: 300 };
    } else {
      try { amounts = await drivingDistance(listing.locationCoordinates, destination, { env, send, timeout }); }
      catch (error) {
        const attempts = record.attempts + 1, noRoute = record.noRoute || error.code === 'NO_DRIVING_ROUTE';
        await DeliveryQuote.updateOne({ _id: record._id }, { $set: { attempts, noRoute, state: error.code === 'ROUTING_TEMPORARY' ? 'temporary' : error.code === 'NO_DRIVING_ROUTE' ? 'no-route' : 'unavailable' }, $unset: { quote: '' } });
        error.fallbackAllowed = error.code === 'ROUTING_TEMPORARY' && attempts >= 2 && !noRoute;
        throw error;
      }
    }
    const rentalAmount = Math.round(listing.price * dates.days * 100) / 100;
    const totalPrice = Math.round((rentalAmount + amounts.deliveryCharge) * 100) / 100;
    if (!Number.isFinite(totalPrice) || totalPrice < 0 || totalPrice > Number.MAX_SAFE_INTEGER / 100) throw deliveryError(400, 'INVALID_PRICE', 'The booking total cannot be calculated safely.');
    const quote = { kind: fallback ? 'estimated' : 'calculated', ...amounts, rentalAmount, totalPrice,
      pickupCoordinates: coordinateValue(listing.locationCoordinates), pickupAddress: listing.location,
      deliveryCoordinates: coordinateValue(destination), deliveryAddress: address.trim(), quotedAt: now.toISOString() };
    await DeliveryQuote.updateOne({ _id: record._id }, { $set: { quote, state: quote.kind, ...(fallback ? {} : { noRoute: false }) } });
    return { ...quote, quoteId: `${record._id}.${hash(quote)}`, expiresAt: record.expiresAt.toISOString() };
  } finally { await DeliveryQuote.updateOne({ _id: record._id }, { $unset: { busyUntil: '' } }); }
}
export async function reviewedDeliveryQuote({ quoteId, userId, listing, dates, destination, address, area, session }) {
  if (!/^[a-f\d]{24}\.[a-f\d]{64}$/i.test(quoteId || '')) throw deliveryError(400, 'DELIVERY_QUOTE_REQUIRED', 'Calculate and review a delivery quote before submitting this booking.');
  validateDeliveryLocations(listing, destination, area);
  const record = await DeliveryQuote.findOne({ _id: quoteId.split('.')[0], user: userId, listing: listing._id, expiresAt: { $gt: new Date() }, state: { $in: ['calculated', 'estimated'] } }).session(session || null).lean();
  const binding = quoteBinding({ userId, listing, dates, destination, address, area });
  if (!record?.quote || record.binding !== binding || hash(record.quote) !== quoteId.split('.')[1]) throw deliveryError(409, 'STALE_DELIVERY_QUOTE', 'The delivery quote expired or the locations, dates or pricing changed. Recalculate and review the quote.');
  return { ...record.quote, quoteId };
}
