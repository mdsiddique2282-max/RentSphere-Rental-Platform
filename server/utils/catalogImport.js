import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { QUICK_KEYS, QUICK_PROFILE } from '../catalog/quickSelection.js';

const { ObjectId, BSON } = mongoose.mongo;
const fail = message => { throw new Error(message); };
const idPattern = /^[0-9a-f]{24}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const isolatedClients = new WeakMap();
export const BATCH = 'mumbai-2026-v1';
export const disclosure = 'Sample inventory — not a verified rental offer or real reservation.';
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const fixedId = key => createHash('sha256').update(`rentsphere/mumbai-2026/${key}`).digest('hex').slice(0, 24);
const validUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
};
const noOperators = value => {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$') || key.includes('.')) fail('MongoDB operators/dotted keys are forbidden in catalog data.');
    noOperators(child);
  }
};

export function validateCatalog(catalog) {
  noOperators(catalog);
  const selected = catalog.selection?.profile === QUICK_PROFILE;
  if (catalog.schemaVersion !== 1 || catalog.batch !== BATCH || catalog.records?.length !== (selected ? 30 : 74)) fail('Expected the full 74-record manifest or the explicit 15+15 selection.');
  if (selected && (!hashPattern.test(catalog.selection.sourceManifestSha256 || '') ||
      JSON.stringify(catalog.selection.keys) !== JSON.stringify(QUICK_KEYS) ||
      JSON.stringify(catalog.records.map(row => row.key)) !== JSON.stringify(QUICK_KEYS))) fail('Invalid 15+15 selection provenance/keys.');
  const keys = new Set(), ids = new Set();
  let properties = 0, vehicles = 0;
  for (const { key, listing } of catalog.records) {
    if (!/^(P(?:0[1-9]|[12]\d|3[0-6])|M(?:0[1-9]|[12]\d|3[0-8]))$/.test(key) || keys.has(key)) fail('Invalid or duplicate catalog key.');
    keys.add(key);
    if (!listing || listing._id !== fixedId(key) || ids.has(listing._id)) fail(`Invalid/colliding fixed ID: ${key}`);
    ids.add(listing._id);
    const type = key.startsWith('P') ? 'property' : 'vehicle';
    if (listing.type !== type || listing.catalogKey !== `mumbai-2026-${key}` || listing.importBatch !== BATCH) fail(`Identity mismatch: ${key}`);
    if (!idPattern.test(listing.host)) fail(`Invalid host ID: ${key}`);
    if (listing.previewOnly !== undefined) fail('Preview-only state cannot be supplied by a manifest.');
    if (listing.inventoryKind !== 'sample' || listing.sampleDisclosure !== disclosure || listing.publicationState !== 'draft') fail(`Sample/draft disclosure required: ${key}`);
    if (listing.city !== 'Mumbai' || !listing.location?.endsWith(', Mumbai, Maharashtra') || /\b(Thane|Navi Mumbai|Vashi)\b/i.test(listing.location)) fail(`Outside Mumbai city/suburbs: ${key}`);
    if (!listing.areaName || !listing.location.startsWith(`${listing.areaName},`)) fail(`Invalid area: ${key}`);
    if (!Number.isFinite(listing.price) || listing.price <= 0 || listing.price > 1000000) fail(`Invalid rate: ${key}`);
    if (!listing.description?.includes('not a verified') || !listing.category || listing.status !== 'available') fail(`Incomplete sample details: ${key}`);
    if (type === 'property') {
      properties++;
      if (listing.ratePeriod !== 'month' || !listing.title?.startsWith('Sample ') ||
          !Number.isInteger(listing.bhk) || listing.bhk < 0 || listing.bhk > 6 ||
          !Number.isFinite(listing.area) || listing.area <= 0 || listing.areaBasis !== 'carpet' ||
          !Number.isInteger(listing.bathrooms) || listing.bathrooms < 1 || !listing.floor ||
          !listing.furnishing || !listing.amenities?.length) fail(`Incomplete property: ${key}`);
    } else {
      vehicles++;
      if (listing.ratePeriod !== 'day' || !listing.name || !['Car', 'Bike'].includes(listing.kind) ||
          !listing.fuel || !listing.transmission || !Number.isInteger(listing.seats) || listing.seats < 1 ||
          !listing.features?.length) fail(`Incomplete vehicle: ${key}`);
    }
  }
  const expected = selected ? [15, 15] : [36, 38];
  if (properties !== expected[0] || vehicles !== expected[1] || catalog.expected?.properties !== expected[0] || catalog.expected?.vehicles !== expected[1]) fail('Catalog counts do not match its declared supported profile.');
  return { properties, vehicles, total: properties + vehicles, manifestSha256: digest(catalog) };
}

export function readiness(catalog, now = new Date()) {
  validateCatalog(catalog);
  const hashes = new Set(), urls = new Set(), perceptualHashes = [];
  return catalog.records.map(record => {
    const { key, listing, media = [], approval = {} } = record;
    const blockers = [];
    if (approval.owner !== 'approved') blockers.push('owner assignment pending');
    if (approval.details !== 'approved' || record.specificationReview?.status !== 'approved') blockers.push('details/physical identity not approved');
    if (approval.media !== 'approved') blockers.push('gallery review pending');
    const [minimum, maximum] = catalog.selection?.profile === QUICK_PROFILE
      ? listing.type === 'property' ? [3, 4] : [2, 3]
      : listing.type === 'property' ? [4, 5] : [3, 4];
    if (media.length < minimum || media.length > maximum) blockers.push(`requires ${minimum}–${maximum} verified photographs; has ${media.length}`);
    const angles = new Set(), setIds = new Set();
    for (const photo of media) {
      if (![photo.url, photo.sourcePage, photo.licenseUrl].every(validUrl) || !photo.author || !photo.attribution) blockers.push('incomplete HTTPS provenance/credit');
      if (!['CC0', 'CC BY 3.0', 'CC BY 4.0', 'CC BY-SA 3.0', 'CC BY-SA 4.0', 'Pexels', 'Unsplash', 'Written permission'].includes(photo.license)) blockers.push('license not approved for this import');
      if (!photo.licenseEvidence || !photo.rightsReviewedBy || photo.rightsApproved !== true) blockers.push('license/permission review missing');
      if (photo.kind !== 'photograph' || photo.matchApproved !== true || !photo.matchReviewedBy || !photo.identityEvidence) blockers.push('genuine matching photograph not established');
      if (photo.depictedCatalogKey !== listing.catalogKey || !photo.setId) blockers.push('wrong listing/photo-set identity');
      setIds.add(photo.setId);
      if (!photo.angle || angles.has(photo.angle)) blockers.push('missing/repeated angle or room');
      angles.add(photo.angle);
      if (photo.qualityApproved !== true || !photo.qualityReviewedBy || photo.width < 1600 || photo.height < 900) blockers.push('image quality/resolution review missing');
      const checked = new Date(photo.checkedAt).getTime();
      if (!Number.isFinite(checked) || checked > now.getTime() || now.getTime() - checked > 7 * 86400000 || photo.httpStatus !== 200 || photo.decoded !== true) blockers.push('URL/decode check missing or stale');
      if (!hashPattern.test(photo.sha256 || '') || hashes.has(photo.sha256) || urls.has(photo.url)) blockers.push('missing hash or repeated image');
      hashes.add(photo.sha256); urls.add(photo.url);
      if (!/^[0-9a-f]{16}$/.test(photo.dHash || '')) blockers.push('near-duplicate check missing');
      else {
        const value = BigInt(`0x${photo.dHash}`);
        if (perceptualHashes.some(previous => {
          let bits = value ^ previous, distance = 0;
          while (bits) { distance++; bits &= bits - 1n; }
          return distance <= 4;
        })) blockers.push('possible repeated/cropped image: manual resolution required');
        perceptualHashes.push(value);
      }
    }
    if (listing.type === 'property' && setIds.size > 1) blockers.push('rooms must belong to one documented property');
    return { key, ready: blockers.length === 0, blockers: [...new Set(blockers)] };
  });
}

function requireReceipt(catalog, approval, targetDatabase) {
  validateCatalog(catalog);
  if (approval?.approved !== true || approval.manifestSha256 !== digest(catalog) || approval.targetDatabase !== targetDatabase) fail('Explicit approval for this exact manifest and target database is required.');
  if (!targetDatabase || targetDatabase.length > 63 || !/^[A-Za-z0-9_-]+$/.test(targetDatabase)) fail('Explicit safe target database name (at most 63 characters) required.');
  // Prevent a data import being mistaken for completed catalog/UI publication.
  if (approval.presentationReviewed !== true) fail('Sample labels, attribution and catalog presentation require review before import.');
  for (const record of catalog.records) {
    const assignment = approval.assignments?.[record.key];
    if (assignment?.approved !== true || assignment.host !== record.listing.host) fail(`Owner assignment approval missing/mismatched: ${record.key}`);
  }
}

export function requireApproval(catalog, approval, targetDatabase, now = new Date()) {
  requireReceipt(catalog, approval, targetDatabase);
  const blocked = readiness(catalog, now).filter(row => !row.ready);
  if (blocked.length) fail(`${blocked.length} listings blocked; first: ${blocked[0].key}: ${blocked[0].blockers.join('; ')}`);
}

// Explicitly authorized temporary-demo policy. Placeholders never satisfy the
// photographic checks; any supplied real photograph still must pass them.
export function validateTemporarySample(catalog, now = new Date()) {
  validateCatalog(catalog);
  if (catalog.selection?.profile !== QUICK_PROFILE) fail('Temporary placeholders are supported only for the selected 15+15 samples.');
  const informational = new Set(['owner assignment pending', 'details/physical identity not approved', 'gallery review pending']);
  const photoProblems = readiness(catalog, now).flatMap(row => row.blockers.filter(reason =>
    !informational.has(reason) && !/^requires \d+–\d+ verified photographs; has \d+$/.test(reason)));
  if (photoProblems.length) fail(`Supplied photographs failed verification: ${photoProblems[0]}`);
  const hashes = new Set();
  for (const record of catalog.records) {
    const minimum = record.listing.type === 'property' ? 3 : 2;
    if (!Array.isArray(record.previewGallery) || record.previewGallery.length < minimum || record.previewGallery.length > minimum + 1) fail(`Invalid demo gallery: ${record.key}`);
    for (const asset of record.previewGallery) {
      if (!hashPattern.test(asset.sha256 || '') || hashes.has(asset.sha256) || !asset.label ||
        !(asset.kind === 'placeholder' && /photo unavailable.*Demo\/Sample/.test(asset.label) && asset.attribution && new RegExp(`^/catalog-placeholders/${record.key}-[1-4]\\.svg$`).test(asset.url) ||
          asset.kind === 'photograph' && record.media.some(photo => photo.sha256 === asset.sha256) && new RegExp(`^/catalog-media/${record.key}/[a-z0-9-]+\\.jpg$`).test(asset.url))) fail(`Untrusted/repeated demo gallery asset: ${record.key}`);
      hashes.add(asset.sha256);
    }
  }
}

export function requireTemporarySampleApproval(catalog, approval, targetDatabase, now = new Date()) {
  requireReceipt(catalog, approval, targetDatabase);
  if (approval.temporaryPlaceholdersApproved !== true || approval.sampleDetailsApproved !== true) fail('Explicit approval of fictional sample details and temporary placeholders is required.');
  validateTemporarySample(catalog, now);
}

export function buildDocuments(catalog, now = new Date(), { isolatedPreview = false, temporarySamples = false, publishSamples = false } = {}) {
  return catalog.records.map(record => ({
    ...record.listing, _id: new ObjectId(record.listing._id), host: new ObjectId(record.listing.host),
    // Import is staging only. Existing public routes must hide these drafts.
    publicationState: isolatedPreview || temporarySamples && publishSamples ? 'published' : 'draft',
    ...(isolatedPreview ? { previewOnly: true } : {}),
    ...(isolatedPreview || temporarySamples ? { mediaState: record.previewGallery.some(photo => photo.kind === 'placeholder') ? 'placeholder' : 'reference-photos' } : {}),
    image: isolatedPreview || temporarySamples ? record.previewGallery[0].url : record.media[0].url,
    gallery: isolatedPreview || temporarySamples ? record.previewGallery.map(photo => photo.url) : record.media.map(photo => photo.url),
    mediaCredits: record.media.map(({ url, sourcePage, author, license, licenseUrl, attribution, angle, sha256 }) =>
      ({ url, sourcePage, author, license, licenseUrl, attribution, angle, sha256 })),
    catalogDocumentHash: digest({ listing: record.listing, media: record.media }),
    createdAt: now, updatedAt: now,
  }));
}

const snapshot = documents => digest(documents.map(document => BSON.EJSON.serialize(document))
  .sort((a, b) => JSON.stringify(a._id).localeCompare(JSON.stringify(b._id))));

export async function importCatalog({ client, catalog, approval, targetDatabase, verifyPhotos, now = new Date(), isolatedPreviewToken }) {
  const isolatedPreview = isolatedPreviewToken !== undefined;
  const temporarySamples = !isolatedPreview && approval?.temporaryPlaceholdersApproved === true;
  if (isolatedPreview) {
    const permit = isolatedClients.get(client);
    if (!permit || permit.token !== isolatedPreviewToken || permit.database !== targetDatabase) fail('Preview publication is restricted to a disposable database created by this module.');
    validateCatalog(catalog);
    validateTemporarySample(catalog, now);
  } else if (temporarySamples) requireTemporarySampleApproval(catalog, approval, targetDatabase, now);
  else requireApproval(catalog, approval, targetDatabase, now);
  if (typeof verifyPhotos !== 'function') fail('Fresh binary image verification is required before any database operation.');
  await verifyPhotos(catalog); // The CLI rechecks actual images before connecting.
  const db = client.db(targetDatabase);
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      const listings = db.collection('listings'), bookings = db.collection('bookings');
      const documents = buildDocuments(catalog, now, { isolatedPreview, temporarySamples, publishSamples: approval?.publishSamples === true });
      const hosts = await db.collection('users').find({ _id: { $in: documents.map(row => row.host) } },
        { session, projection: { _id: 1, role: 1, 'ownerProfile.status': 1 } }).toArray();
      for (const document of documents) {
        const host = hosts.find(user => user._id.equals(document.host));
        if (!host || (host.role !== 'admin' && !(host.role === 'owner' && host.ownerProfile?.status === 'approved'))) fail('Assigned account is missing or lacks current publishing approval.');
      }
      const beforeListings = await listings.find({}, { session }).toArray();
      const beforeBookings = await bookings.find({}, { session }).toArray();
      let inserted = 0, skipped = 0;
      for (const document of documents) {
        const existing = await listings.findOne({ $or: [{ _id: document._id }, { catalogKey: document.catalogKey }] }, { session });
        if (existing) {
          if (!existing._id.equals(document._id) || existing.catalogKey !== document.catalogKey || existing.importBatch !== BATCH) fail('Catalog identity collision; no record will be overwritten.');
          const { createdAt, updatedAt, ...expected } = document;
          const actual = Object.fromEntries(Object.keys(expected).map(key => [key, existing[key]]));
          if (digest(BSON.EJSON.serialize(actual)) !== digest(BSON.EJSON.serialize(expected))) fail(`Existing imported record differs: ${document.catalogKey}; no overwrite permitted.`);
          skipped++;
        } else {
          await listings.insertOne(document, { session });
          inserted++;
        }
      }
      const oldIds = beforeListings.map(row => row._id);
      const afterOld = await listings.find({ _id: { $in: oldIds } }, { session }).toArray();
      if (snapshot(beforeListings) !== snapshot(afterOld) || snapshot(beforeBookings) !== snapshot(await bookings.find({}, { session }).toArray())) fail('Existing listings or booking history changed; aborting transaction.');
      return { inserted, skipped, preservedListings: beforeListings.length, preservedBookings: beforeBookings.length,
        publicationState: isolatedPreview ? 'published (isolated preview only)' : temporarySamples && approval.publishSamples === true ? 'published sample inventory' : 'draft' };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } finally { await session.endSession(); }
}

// There is deliberately no URI argument or CLI flag for preview publication.
// A permit is minted only for a MongoDB process this function itself starts.
export async function createIsolatedCatalogDatabase() {
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const { default: os } = await import('node:os');
  const { default: path } = await import('node:path');
  const mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: path.join(os.tmpdir(), 'rentsphere-test-mongodb') },
    replSet: { count: 1, storageEngine: 'wiredTiger',
      // Windows broadcasts console Ctrl+C to children too. Let our cleanup stop
      // mongod, instead of racing a mongod that has already received Ctrl+C.
      spawn: process.platform === 'win32' ? { detached: true, windowsHide: true } : {} } });
  const client = new mongoose.mongo.MongoClient(mongo.getUri());
  const targetDatabase = `rentsphere_preview_${randomUUID().replaceAll('-', '')}`;
  const token = randomUUID();
  try { await client.connect(); }
  catch (error) {
    try { await client.close(); } finally { await mongo.stop(); }
    throw error;
  }
  isolatedClients.set(client, { database: targetDatabase, token });
  return { client, targetDatabase, token, uri: mongo.getUri(), close: async () => {
    isolatedClients.delete(client);
    try { await client.close(); } finally {
      if (await mongo.stop() === false) throw new Error('Disposable MongoDB did not stop cleanly.');
    }
  } };
}
