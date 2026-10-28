// Local preview only. Never loads production credentials or accepts a database URI.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Booking from '../models/Booking.js';
import { properties, vehicles } from '../../src/data/listings.js';
import { buildDocuments, createIsolatedCatalogDatabase, readiness, validateCatalog } from './catalogImport.js';
import { verifyPreviewAssets } from './catalogMedia.js';
import { QUICK_KEYS } from '../catalog/quickSelection.js';
import { lockPreviewState } from './previewStateLock.js';

export const FINAL_PREVIEW_KEYS = [...QUICK_KEYS];
export const INCOMPLETE_PHOTO_KEYS = ['M26'];
const oid = value => new mongoose.mongo.ObjectId(value);
const fixedId = value => createHash('sha256').update(`RentSphere-preview/${value}`).digest('hex').slice(0, 24);
export const previewProjectKey = fixedId(fileURLToPath(new URL('../../', import.meta.url)));
export const previewStateDirectory = () => process.env.RENTSPHERE_PREVIEW_STATE_DIR ||
  join(homedir(), 'Documents', 'Codex', '.rentsphere-preview', previewProjectKey);
const readJson = async name => JSON.parse(await readFile(new URL(`../catalog/${name}`, import.meta.url), 'utf8'));
const signature = row => `${row.title || row.name}|${row.location}|${row.price}`.toLowerCase();

export async function finalPreviewCatalog() {
  const catalog = await readJson('mumbai-15x15.json');
  validateCatalog(catalog);
  const references = await readJson('reference-galleries.json');
  for (const row of catalog.records.filter(row => FINAL_PREVIEW_KEYS.includes(row.key))) {
    if (!references[row.key]) continue; // M06 keeps its reviewed set; M26 remains incomplete.
    row.media = references[row.key].media;
    row.previewGallery = references[row.key].previewGallery;
    row.approval.media = 'approved';
  }
  // The user explicitly permits one reference photo per property. All existing
  // copyright, match, quality and duplicate checks still apply to supplied photos.
  const allowed = /^(owner assignment pending|details\/physical identity not approved|requires \d+–\d+ verified photographs; has \d+)$/;
  const checks = readiness(catalog);
  const records = catalog.records.filter(row => FINAL_PREVIEW_KEYS.includes(row.key));
  for (const row of records) {
    if (INCOMPLETE_PHOTO_KEYS.includes(row.key)) {
      if (row.media.length || !row.previewGallery.every(photo => photo.kind === 'placeholder')) throw new Error('M26 must remain honestly photo-incomplete.');
      continue;
    }
    const problems = checks.find(check => check.key === row.key).blockers.filter(reason => !allowed.test(reason));
    if (problems.length || row.media.length < 1 || row.media.length > 3 ||
        row.previewGallery.length !== row.media.length || row.previewGallery.some(photo => photo.kind !== 'photograph' || !row.media.some(source => source.sha256 === photo.sha256))) {
      throw new Error(`Incomplete preview gallery ${row.key}: ${problems.join('; ')}`);
    }
  }
  const selected = { ...catalog, records };
  await verifyPreviewAssets(selected);
  return selected;
}

export async function startFinalCatalogDatabase({ persist = false, stateDirectory } = {}) {
  const catalog = await finalPreviewCatalog();
  const originals = await readJson('original-listings.json');
  const directory = stateDirectory || previewStateDirectory();
  const stateFile = join(directory, 'state.json');
  let state, releaseState;
  if (persist) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '.gitignore'), '*\n');
    releaseState = await lockPreviewState(directory);
    try { state = mongoose.mongo.BSON.EJSON.parse(await readFile(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') { await releaseState(); throw error; } }
    if (state && (state.version !== 1 || !state.secret || !state.collections)) { await releaseState(); throw new Error('Invalid isolated preview state; preserved without overwriting.'); }
  }
  let isolated;
  try { isolated = await createIsolatedCatalogDatabase(); } catch (error) { await releaseState?.(); throw error; }
  const db = isolated.client.db(isolated.targetDatabase);
  let closing, saveQueue = Promise.resolve();
  const save = () => {
    if (!persist) return Promise.resolve();
    const operation = saveQueue.catch(() => {}).then(async () => {
      const collections = {};
      for (const { name } of await db.listCollections().toArray()) {
        if (!name.startsWith('system.')) collections[name] = await db.collection(name).find({}).toArray();
      }
      await writeFile(`${stateFile}.tmp`, mongoose.mongo.BSON.EJSON.stringify({ version: 1,
        secret: process.env.JWT_SECRET, collections }), { mode: 0o600 });
      await rename(`${stateFile}.tmp`, stateFile);
    });
    saveQueue = operation;
    return operation;
  };
  const close = () => closing ??= (async () => {
    try { await save(); } finally {
      try { await mongoose.disconnect(); } finally { try { await isolated.close(); } finally { await releaseState?.(); } }
    }
  })();
  try {
    process.env.JWT_SECRET = state?.secret || randomBytes(48).toString('hex');
    if (state) {
      for (const [name, rows] of Object.entries(state.collections)) {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Invalid preview collection name.');
        if (rows.length) await db.collection(name).insertMany(rows);
      }
    }
    await mongoose.connect(isolated.uri, { dbName: isolated.targetDatabase });
    await User.init();
    await User.createIndexes();
    await Booking.createIndexes();
    const ensureHost = async (id, name, email) => {
      if (!await User.exists({ _id: id })) await User.create({ _id: id, name, email,
        role: 'admin', password: randomBytes(32).toString('hex') });
    };
    for (const owner of originals.owners) await ensureHost(owner._id, owner.name, owner.email);
    const insertOnly = async document => {
      if (!await db.collection('listings').findOne({ _id: document._id })) await db.collection('listings').insertOne(document);
    };
    for (const original of originals.listings) {
      const document = { ...original, _id: oid(original._id), host: oid(original.host) };
      for (const key of ['createdAt', 'updatedAt']) if (document[key]) document[key] = new Date(document[key]);
      await insertOnly(document);
    }
    let frontendCount = 0;
    for (const [type, rows] of [['property', properties], ['vehicle', vehicles]]) for (const legacy of rows) {
      if (originals.listings.some(row => signature(row) === signature(legacy))) continue;
      frontendCount++;
      const host = fixedId(`host/${legacy.owner || legacy.brand}`);
      await ensureHost(host, legacy.owner || `${legacy.brand} Partner`, `${host}@rentsphere.test`);
      await insertOnly({ ...legacy, _id: oid(fixedId(legacy.id)), legacyId: legacy.id, type,
        category: legacy.category || legacy.type, host: oid(host),
        status: legacy.available === false || /rented|unavailable/i.test(legacy.availability || '') ? 'rented' : 'available',
        gallery: legacy.gallery?.length ? legacy.gallery : [legacy.image] });
    }
    for (const document of buildDocuments(catalog, new Date(), { isolatedPreview: true })) await insertOnly(document);
    // Separate local administrator: never overwrite an existing account/password.
    const adminId = fixedId('preview-admin');
    let adminLogin;
    if (!await User.exists({ _id: adminId })) {
      if (await User.exists({ email: 'preview-admin@rentsphere.test' })) throw new Error('Preview admin email collision; existing account preserved.');
      adminLogin = { email: 'preview-admin@rentsphere.test', password: randomBytes(24).toString('base64url') };
      await User.create({ _id: adminId, name: 'Local Preview Admin', ...adminLogin, role: 'admin' });
      // Keep bootstrap credentials only in memory; persist only the bcrypt hash.
    }
    const demoId = fixedId('demo-user');
    if (!await User.exists({ _id: demoId })) await User.create({ _id: demoId, name: 'Demo User',
      email: 'demo@rentsphere.test', password: 'RentSphereDemo2026!', role: 'user' });
    const user = await User.findById(demoId);
    await save();
    return { ...isolated, catalog, user, adminLogin, save, close,
      counts: { originalDatabase: originals.listings.length, originalFrontend: frontendCount, newProperties: 15, newVehicles: 15 },
      result: { inserted: catalog.records.length } };
  } catch (error) {
    // Do not replace a good saved state if startup/restore is incomplete.
    try { await mongoose.disconnect(); } finally { try { await isolated.close(); } finally { await releaseState?.(); } }
    throw error;
  }
}
