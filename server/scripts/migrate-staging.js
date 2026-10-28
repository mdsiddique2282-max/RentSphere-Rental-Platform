// Default is OFFLINE. Never imports env.js, server.js, seed.js or a preview starter.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';
import { previewStateDirectory } from '../utils/finalCatalogPreview.js';
import { readMigrationSnapshot, connectApprovedStaging, inspectMigrationTarget, applyStagingMigration, migrationRolePlan } from '../utils/stagingMigration.js';
import { inspectMigrationMedia } from '../utils/migrationMedia.js';

export async function main(args = process.argv.slice(2)) {
  const flags = new Set(['--dry-run', '--inspect-target', '--apply']);
  const values = new Set(['--approve-connection', '--approve-migration', '--snapshot']);
  const options = {};
  for (let i=0;i<args.length;i++) {
    const key = args[i];
    if (key in options || (!flags.has(key) && !values.has(key))) throw new Error('Invalid or duplicate migration option.');
    options[key] = flags.has(key) ? true : args[++i];
    if (!options[key]) throw new Error('Missing migration option value.');
  }
  if ([...flags].filter(key => options[key]).length > 1) throw new Error('Choose one migration mode.');
  const source = await readMigrationSnapshot(options['--snapshot'] || join(previewStateDirectory(), 'state.json'));
  const media = await inspectMigrationMedia(source);
  source.mediaSha256 = media.sha256;
  if (!options['--inspect-target'] && !options['--apply']) {
    console.log(JSON.stringify({ offline: true, counts: source.counts, sourceSha256: source.sourceSha256,
      ...migrationRolePlan(source), originalDataSha256: source.originalDataSha256,
      passwordHashesPreserved: true, media, connectionAttempted: false }, null, 2));
    return;
  }
  if (!options['--approve-connection']) throw new Error('Atlas access is disabled without explicit approval of the offline source fingerprint.');
  if (options['--apply']) {
    // A running preview can have unsaved changes. Never stop/reset it automatically.
    try { await readFile(join(resolve(source.file, '..'), 'active.lock')); throw new Error('Stop the isolated preview cleanly before migration, then repeat offline verification.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!options['--approve-migration']) throw new Error('Apply requires separate approval of a read-only target preflight digest.');
  }
  let local = {};
  try { local = parse(await readFile(new URL('../.env.staging.local', import.meta.url))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const env = { ...local, ...process.env, RENTSPHERE_DATABASE_MODE: 'staging' };
  const target = await connectApprovedStaging(env, options['--approve-connection'], source);
  try {
    const preflight = await inspectMigrationTarget(target, source);
    if (options['--inspect-target']) { console.log(JSON.stringify({ readOnly: true, ...preflight }, null, 2)); return; }
    const result = await applyStagingMigration({ target, source, approvedDigest: options['--approve-migration'],
      backupDirectory: fileURLToPath(new URL('../.staging-backups/', import.meta.url)), backupKey: env.RENTSPHERE_MIGRATION_BACKUP_KEY });
    console.log(JSON.stringify(result, null, 2));
  } finally { await target.client.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Staging operation refused or failed. Check approvals, snapshot integrity, private configuration and target conflicts. No credential or document details are logged; repeat read-only verification before retrying.');
    process.exitCode = 1;
  });
}
