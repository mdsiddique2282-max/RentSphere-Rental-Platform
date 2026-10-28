import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export async function inspectMigrationMedia(source, root = projectRoot, expectedCount = 154) {
  const hashes = [], counts = { catalog: 0, placeholders: 0, uploads: 0, remote: 0, embedded: 0 };
  const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
  async function walk(directory, prefix) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('Media symlinks require review before migration.');
      const file = join(directory, entry.name), relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(file, relative + '/');
      else hashes.push([relative, fingerprint(await readFile(file))]);
    }
  }
  for (const dir of ['public/catalog-media', 'public/catalog-placeholders', 'uploads', 'server/uploads']) await walk(join(root, dir), dir + '/');
  if (hashes.length !== expectedCount) throw new Error('Media inventory differs from the approved baseline.');
  const urls = new Set(source.collections.listings.flatMap(row => [row.image, ...(row.gallery || [])].filter(Boolean)));
  for (const user of source.collections.users) for (const ref of user.ownerProfile?.documents || []) if (ref.startsWith('/uploads/')) urls.add(ref);
  for (const url of urls) {
    if (/^https?:\/\//.test(url)) { counts.remote++; continue; }
    if (url.startsWith('data:')) { counts.embedded++; continue; }
    let files;
    if (url.startsWith('/catalog-media/') || url.startsWith('/catalog-placeholders/')) {
      const directory = url.startsWith('/catalog-media/') ? 'catalog-media' : 'catalog-placeholders';
      const base = resolve(root, 'public', directory), file = resolve(root, 'public', '.' + url);
      if (!file.startsWith(base + sep)) throw new Error('Unsafe local media reference.');
      files = [file]; counts[directory === 'catalog-media' ? 'catalog' : 'placeholders']++;
    } else if (/^\/uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(url)) {
      files = [join(root, 'server/uploads', basename(url)), join(root, 'uploads', basename(url))]; counts.uploads++;
    } else throw new Error('Unsupported local media reference requires review.');
    const found = [];
    for (const file of files) {
      try { if ((await stat(file)).isFile()) found.push(fingerprint(await readFile(file))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!found.length || new Set(found).size > 1) throw new Error('A local media file is missing or has conflicting upload copies.');
  }
  return { files: hashes.length, sha256: fingerprint(JSON.stringify(hashes.sort((a,b) => a[0].localeCompare(b[0])))), references: counts };
}
