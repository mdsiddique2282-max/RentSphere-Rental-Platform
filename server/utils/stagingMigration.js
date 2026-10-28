import mongoose from 'mongoose';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { stagingConfig, STAGING_DATABASE, STAGING_USER } from './stagingConfig.js';
import User from '../models/User.js';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';

const EJSON = mongoose.mongo.BSON.EJSON;
const allowedCollections = ['users', 'listings', 'bookings', 'ownerdocuments'];
const targets = new WeakSet();
const fail = message => { throw new Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => {
  const plain = EJSON.serialize(value, { relaxed: false });
  const sort = item => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(plain));
};
const sorted = rows => [...rows].sort((a,b) => String(a._id).localeCompare(String(b._id)));
const dataHash = collections => hash(canonical(Object.fromEntries(Object.keys(collections).sort().map(key => [key, sorted(collections[key])]))));
const rolePolicy = Object.freeze({ version: 'sole-admin-v1', adminEmail: 'admin@rentsphere.com', otherRole: 'user' });
const roleCounts = users => users.reduce((counts, user) => { counts[user.role] = (counts[user.role] || 0) + 1; return counts; }, {});

function mappedPreview(collections) {
  const named = collections.users.filter(user => user.email.trim().toLowerCase() === rolePolicy.adminEmail);
  if (named.length !== 1) fail('The sole administrator must match exactly one existing account; no new admin may be created.');
  // Clone BSON/EJSON, not Mongoose documents: no setters, timestamps or password
  // save hooks run, and no mapped object shares mutable data with the preview.
  const mapped = EJSON.parse(EJSON.stringify(collections));
  let changedAccounts = 0;
  for (const user of mapped.users) {
    const role = String(user._id) === String(named[0]._id) ? 'admin' : rolePolicy.otherRole;
    if (user.role !== role) changedAccounts++;
    user.role = role;
  }
  const mapping = { ...rolePolicy, adminAccountId: String(named[0]._id),
    sourceRoles: roleCounts(collections.users), finalRoles: roleCounts(mapped.users), changedAccounts };
  if (mapping.finalRoles.admin !== 1 || mapping.finalRoles.user !== 13) fail('The migration must contain exactly one admin and thirteen users.');
  return { collections: mapped, mapping };
}

function verifyMapping(source) {
  if (!source.originalCollections || dataHash(source.originalCollections) !== source.originalDataSha256) fail('Original preview data changed in memory; repeat offline verification.');
  const expected = mappedPreview(source.originalCollections);
  if (canonical(source.collections) !== canonical(expected.collections) || canonical(source.roleMapping) !== canonical(expected.mapping)) {
    fail('Migration integrity failed: only the reviewed sole-admin role mapping may differ from the original preview.');
  }
  return dataHash(source.collections);
}

export function migrationRolePlan(source) {
  return { planVersion: 'staging-migration-sole-admin-v1', roleMapping: source.roleMapping,
    mappedDataSha256: verifyMapping(source) };
}

export async function readMigrationSnapshot(file) {
  const bytes = await readFile(file);
  const state = EJSON.parse(bytes.toString());
  if (state.version !== 1 || !state.secret || state.sanitizedBackup || !state.collections) fail('An original private preview snapshot is required; sanitized ZIP exports cannot preserve authentication.');
  for (const key of Object.keys(state.collections)) if (!allowedCollections.includes(key)) fail('An unexpected snapshot collection requires review.');
  const collections = Object.fromEntries(allowedCollections.map(key => [key, state.collections[key] || []]));
  const counts = Object.fromEntries(allowedCollections.map(key => [key, collections[key].length]));
  if (counts.users !== 14 || counts.listings !== 48 || counts.bookings !== 16) fail('Snapshot counts differ from the approved 48 listings / 14 users / 16 bookings.');
  const ids = {};
  for (const key of allowedCollections) {
    ids[key] = new Set(collections[key].map(row => String(row._id)));
    if (ids[key].size !== collections[key].length || collections[key].some(row => !mongoose.isObjectIdOrHexString(row._id))) fail('Duplicate or invalid snapshot identities.');
  }
  const emails = collections.users.map(row => typeof row.email === 'string' ? row.email.trim().toLowerCase() : '');
  if (emails.some(email => !email) || new Set(emails).size !== emails.length) fail('Email collisions require manual review; no accounts may be merged automatically.');
  if (collections.users.some(row => !/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(row.password))) fail('Every migrated account must already have a bcrypt hash.');
  for (const [name, field] of [['listings', 'legacyId'], ['listings', 'catalogKey'], ['bookings', 'requestId']]) {
    const values = collections[name].map(row => row[field]).filter(Boolean);
    if (new Set(values).size !== values.length) fail('Duplicate source catalog or request identities require review.');
  }
  if (collections.listings.some(row => !ids.users.has(String(row.host))) ||
      collections.bookings.some(row => !ids.users.has(String(row.user)) || !ids.listings.has(String(row.listing)) ||
        (row.propertyDecision?.confirmedBy && !ids.users.has(String(row.propertyDecision.confirmedBy)))) ||
      collections.ownerdocuments.some(row => !ids.users.has(String(row.owner)))) fail('A snapshot relationship is unresolved.');
  for (const user of collections.users) for (const reference of user.ownerProfile?.documents || []) {
    if (reference.startsWith('owner-document:') && !ids.ownerdocuments.has(reference.slice(15))) fail('A private document reference is unresolved.');
  }
  // Validate without saving: User.save() would hash an existing hash again.
  for (const [key, Model] of [['users', User], ['listings', Listing], ['bookings', Booking]]) {
    for (const row of collections[key]) {
      try { await new Model(row).validate(); } catch { fail('A snapshot record is incompatible with the current schema.'); }
    }
  }
  const mapped = mappedPreview(collections);
  return { collections: mapped.collections, originalCollections: collections, originalDataSha256: dataHash(collections),
    roleMapping: mapped.mapping, counts, sourceSha256: hash(bytes), file, previewSecret: state.secret };
}

export async function connectApprovedStaging(env, approvedSourceSha256, source) {
  if (approvedSourceSha256 !== source.sourceSha256) fail('Explicit connection approval must match the current offline snapshot fingerprint.');
  const config = stagingConfig(env);
  const client = new mongoose.mongo.MongoClient(config.uri, { dbName: STAGING_DATABASE,
    serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000, retryWrites: true, w: 'majority' });
  try {
    await client.connect();
    const target = Object.freeze({ client, db: client.db(STAGING_DATABASE) });
    targets.add(target); return target;
  } catch { await client.close(); fail('Approved staging connection failed. No URI or credential details are logged.'); }
}

// Tests get a capability only for a new MongoDB process started here. No URI
// parameter, remote-host exception or production bypass flag exists.
export async function createDisposableMigrationTarget() {
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const { tmpdir } = await import('node:os');
  const mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: join(tmpdir(), 'rentsphere-test-mongodb') }, replSet: { count: 1 } });
  const client = new mongoose.mongo.MongoClient(mongo.getUri());
  try { await client.connect(); } catch (error) { await client.close(); await mongo.stop(); throw error; }
  const target = Object.freeze({ client, db: client.db(STAGING_DATABASE), localTest: true });
  targets.add(target);
  return { target, uri: mongo.getUri(), close: async () => { targets.delete(target); await client.close(); await mongo.stop(); } };
}

function checkTarget(target) {
  if (!targets.has(target) || target.db.databaseName !== STAGING_DATABASE) fail('Unapproved database target; production and arbitrary clients are forbidden.');
}
async function snapshotTarget(target, session) {
  checkTarget(target);
  const collections = {};
  for (const { name } of await target.db.listCollections({}, { session }).toArray()) {
    if (name.startsWith('system.')) continue;
    collections[name] = await target.db.collection(name).find({}, { session }).toArray();
  }
  return collections;
}
function insertionPlan(source, before) {
  const insert = {}, skipped = {};
  for (const key of allowedCollections) {
    const existing = before[key] || [], byId = new Map(existing.map(row => [String(row._id), row]));
    if (key === 'users') {
      const emails = existing.map(row => typeof row.email === 'string' ? row.email.trim().toLowerCase() : '');
      if (emails.some(email => !email) || new Set(emails).size !== emails.length) fail('Existing staging email collisions require review.');
      if (existing.some(row => row.role === 'admin' && row.email.trim().toLowerCase() !== rolePolicy.adminEmail)) fail('Staging contains an admin outside the sole-admin policy; existing roles will not be overwritten.');
    }
    insert[key] = []; skipped[key] = 0;
    for (const row of source.collections[key]) {
      const match = byId.get(String(row._id));
      if (match) {
        if (canonical(match) !== canonical(row)) fail('An existing staging record differs from the source. Overwrite is forbidden; review is required.');
        skipped[key]++; continue;
      }
      if (key === 'users' && existing.some(old => old.email?.trim().toLowerCase() === row.email.trim().toLowerCase())) fail('A staging email identity collision requires review.');
      if (key === 'listings' && existing.some(old => (row.legacyId && old.legacyId === row.legacyId) || (row.catalogKey && old.catalogKey === row.catalogKey))) fail('A staging catalog identity collision requires review.');
      if (key === 'bookings' && existing.some(old => (row.requestId && old.requestId === row.requestId) ||
        (row.submissionKey && old.submissionKey === row.submissionKey && ['pending', 'confirmed'].includes(row.status) && ['pending', 'confirmed'].includes(old.status)))) fail('A staging booking identity collision requires review.');
      insert[key].push(row);
    }
  }
  return { insert, skipped };
}
export async function inspectMigrationTarget(target, source) {
  const rolePlan = migrationRolePlan(source);
  checkTarget(target);
  const hello = await target.db.command({ hello: 1 });
  if ((!hello.setName && hello.msg !== 'isdbgrid') || hello.logicalSessionTimeoutMinutes === undefined) fail('Target transaction topology is not supported.');
  if (!target.localTest) {
    const { authInfo } = await target.db.command({ connectionStatus: 1 });
    if (authInfo?.authenticatedUsers?.length !== 1 || authInfo.authenticatedUsers[0].user !== STAGING_USER ||
        authInfo.authenticatedUserRoles?.length !== 1 || authInfo.authenticatedUserRoles[0].role !== 'readWrite' ||
        authInfo.authenticatedUserRoles[0].db !== STAGING_DATABASE) fail('The authenticated staging-only account/role must be verified before migration.');
  }
  const before = await snapshotTarget(target);
  const plan = insertionPlan(source, before);
  const details = { ...rolePlan, database: STAGING_DATABASE,
    transactions: 'replica-set-or-sharded-session-topology',
    permissions: target.localTest ? 'disposable-local-test' : 'verified-readWrite-on-staging-only',
    sourceSha256: source.sourceSha256, sourceMediaSha256: source.mediaSha256 || null, targetDataSha256: dataHash(before),
    beforeCounts: Object.fromEntries(Object.entries(before).map(([k,v]) => [k,v.length])),
    insertCounts: Object.fromEntries(allowedCollections.map(k => [k, plan.insert[k].length])), skipped: plan.skipped };
  return { ...details, approvalDigest: hash(canonical(details)) };
}

export async function verifyEncryptedMigrationBackup(file, key, expectedContents) {
  try {
    const bytes = await readFile(file);
    if (bytes.length < 33 || bytes.subarray(0, 5).toString() !== 'RSBK1') fail('Invalid backup format.');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(5, 17));
    decipher.setAuthTag(bytes.subarray(17, 33));
    const recovered = Buffer.concat([decipher.update(bytes.subarray(33)), decipher.final()]);
    if (!recovered.equals(Buffer.from(expectedContents))) fail('Backup content mismatch.');
    return true;
  } catch { fail('Encrypted backup verification failed; no migration writes are permitted.'); }
}

export async function applyStagingMigration({ target, source, approvedDigest, backupDirectory, backupKey }) {
  checkTarget(target);
  const plan = await inspectMigrationTarget(target, source);
  if (!approvedDigest || plan.approvalDigest !== approvedDigest) fail('Migration approval does not match the current staging/source fingerprints.');
  const key = Buffer.from(backupKey || '', 'base64');
  if (key.length !== 32) fail('A private base64-encoded 32-byte encryption key is required before any migration writes.');
  const before = await snapshotTarget(target);
  if (dataHash(before) !== plan.targetDataSha256) fail('Staging changed after preflight; inspect and approve again.');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const backupContents = EJSON.stringify({ database: STAGING_DATABASE, collections: before,
    sourceSha256: source.sourceSha256, roleMapping: source.roleMapping,
    sourcePreview: { version: 1, secret: source.previewSecret, collections: source.originalCollections } });
  const encrypted = Buffer.concat([cipher.update(backupContents), cipher.final()]);
  await mkdir(backupDirectory, { recursive: true });
  const backup = join(backupDirectory, `staging-before-${Date.now()}-${randomBytes(6).toString('hex')}.enc`);
  await writeFile(backup, Buffer.concat([Buffer.from('RSBK1'), iv, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: 'wx' });
  await verifyEncryptedMigrationBackup(backup, key, backupContents);
  // Index creation is an approved staging write. Never sync/drop existing indexes.
  for (const [name, Model] of [['users', User], ['listings', Listing], ['bookings', Booking]]) {
    for (const [keys, options] of Model.schema.indexes()) await target.db.collection(name).createIndex(keys, options);
  }
  const session = target.client.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const current = {};
      // Avoid listCollections inside a transaction: use collection names from
      // the read-only preflight plus the known migration collections.
      for (const name of new Set([...Object.keys(before), ...allowedCollections])) current[name] = await target.db.collection(name).find({}, { session }).toArray();
      const originalComparable = Object.fromEntries(Object.keys(before).map(name => [name, current[name]]));
      if (dataHash(originalComparable) !== plan.targetDataSha256 || allowedCollections.some(name => !before[name] && current[name].length)) fail('Staging changed after backup; no migration records were committed.');
      const next = insertionPlan(source, current);
      verifyMapping(source);
      for (const name of allowedCollections) if (next.insert[name].length) await target.db.collection(name).insertMany(next.insert[name], { session, ordered: true });
      // Compare raw native documents: preserve every hash, field, type and ID.
      for (const name of allowedCollections) {
        const actual = await target.db.collection(name).find({ _id: { $in: source.collections[name].map(row => row._id) } }, { session }).toArray();
        if (canonical(sorted(actual)) !== canonical(sorted(source.collections[name]))) fail('Post-migration source integrity check failed.');
      }
      for (const name of Object.keys(before)) {
        const retained = await target.db.collection(name).find({ _id: { $in: before[name].map(row => row._id) } }, { session }).toArray();
        if (canonical(sorted(retained)) !== canonical(sorted(before[name]))) fail('Pre-existing staging data changed; transaction aborted.');
      }
      return { inserted: Object.fromEntries(allowedCollections.map(name => [name, next.insert[name].length])), skipped: next.skipped,
        roleMapping: source.roleMapping, mappedDataSha256: verifyMapping(source) };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return { ...result, backup, backupVerified: true, verified: true };
  } finally { await session.endSession(); }
}
