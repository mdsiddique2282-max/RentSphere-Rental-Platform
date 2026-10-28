import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { createIsolatedCatalogDatabase, importCatalog } from './catalogImport.js';

export { verifyPreviewAssets } from './catalogMedia.js';
import { verifyPreviewAssets } from './catalogMedia.js';
import { startFinalCatalogDatabase } from './finalCatalogPreview.js';

export async function startQuickCatalogDatabase(options = {}) {
  if (options.finalOnly) return startFinalCatalogDatabase(options);
  const catalog = JSON.parse(await readFile(new URL('../catalog/mumbai-15x15.json', import.meta.url), 'utf8'));
  const isolated = await createIsolatedCatalogDatabase();
  let closing;
  const close = () => closing ??= (async () => {
    try { await mongoose.disconnect(); } finally { await isolated.close(); }
  })();
  try {
    process.env.JWT_SECRET = randomBytes(48).toString('hex');
    await mongoose.connect(isolated.uri, { dbName: isolated.targetDatabase });
    await User.init();
    const host = catalog.records[0].listing.host;
    await User.create({ _id: host, name: 'Sample Inventory Custodian (isolated demo)',
      email: 'custodian@rentsphere.test', password: randomBytes(24).toString('hex'), role: 'admin' });
    const user = await User.create({ name: 'Demo User', email: 'demo@rentsphere.test',
      password: 'RentSphereDemo2026!', role: 'user' });
    const result = await importCatalog({ client: isolated.client, catalog,
      targetDatabase: isolated.targetDatabase, isolatedPreviewToken: isolated.token,
      verifyPhotos: verifyPreviewAssets });
    return { ...isolated, catalog, user, result, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) {
      console.error('Preview startup cleanup failed:', cleanupError.message);
    }
    throw error;
  }
}
