import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const uploadDirectory = fileURLToPath(new URL('../uploads/', import.meta.url));
const legacyDirectory = fileURLToPath(new URL('../../uploads/', import.meta.url));
export function existingUpload(filename) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(filename)) return null;
  for (const root of [uploadDirectory, legacyDirectory]) if (existsSync(path.join(root, filename))) return { root, path: path.join(root, filename) };
  return null;
}
