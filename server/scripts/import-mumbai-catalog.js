// Defaults to an entirely offline dry-run. Never loads .env or production models.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { validateCatalog, readiness, requireApproval, requireTemporarySampleApproval, importCatalog } from '../utils/catalogImport.js';
import { verifyPreviewAssets } from '../utils/catalogMedia.js';
import { loadImageDecoder, verifyCatalogPhotos } from '../utils/catalogMedia.js';

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (['--apply', '--check-images'].includes(name)) { options[name] = true; continue; }
    if (!['--manifest', '--approval', '--uri-env', '--target-db', '--decoder-module'].includes(name) ||
        !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown/incomplete option: ${name}`);
    if (options[name]) throw new Error(`Repeated option: ${name}`);
    options[name] = args[++index];
  }
  const catalog = JSON.parse(await readFile(options['--manifest'] || new URL('../catalog/mumbai-2026.json', import.meta.url), 'utf8'));
  const summary = validateCatalog(catalog);
  const rows = readiness(catalog);
  console.log(JSON.stringify({ mode: options['--apply'] ? 'apply-requested' : 'offline-dry-run', ...summary,
    ready: rows.filter(row => row.ready).length, blocked: rows.filter(row => !row.ready).length,
    blockers: rows.filter(row => !row.ready).map(({ key, blockers }) => ({ key, blockers })) }, null, 2));
  if (!options['--apply']) {
    if (options['--check-images']) await verifyCatalogPhotos(catalog, { decoder: await loadImageDecoder(options['--decoder-module']) });
    return; // No client is constructed and no database is contacted.
  }
  if (!options['--approval'] || !options['--target-db'] || !options['--uri-env']) throw new Error('Apply requires an approval file, an explicit target database and an explicit URI environment-variable name.');
  const approval = JSON.parse(await readFile(options['--approval'], 'utf8'));
  const temporarySamples = approval.temporaryPlaceholdersApproved === true;
  (temporarySamples ? requireTemporarySampleApproval : requireApproval)(catalog, approval, options['--target-db']); // Reject before reading URI/connecting.
  const uri = process.env[options['--uri-env']];
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri)) throw new Error('Explicit MongoDB connection setting missing/invalid. No fallback is permitted.');
  const url = new URL(uri);
  if (decodeURIComponent(url.pathname.slice(1)) !== options['--target-db']) throw new Error('URI database must exactly match the approved target database.');
  const decoder = temporarySamples ? null : await loadImageDecoder(options['--decoder-module']);
  const verify = temporarySamples ? verifyPreviewAssets : data => verifyCatalogPhotos(data, { decoder });
  await verify(catalog);
  const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 15000, retryWrites: false });
  try {
    await client.connect();
    const result = await importCatalog({ client, catalog, approval, targetDatabase: options['--target-db'],
      verifyPhotos: verify });
    console.log(JSON.stringify(result));
  } finally { await client.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    // Never print connection URIs, driver traces, credentials, or customer data.
    const safe = /Mongo|ServerSelection|Network|Authentication/.test(error.name)
      ? `Database operation failed (${error.name}); no credential details logged.` : error.message;
    console.error(safe); process.exitCode = 1;
  });
}
