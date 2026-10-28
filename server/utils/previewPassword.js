// Offline saved-preview files only. Never loads .env or opens a database.
import { readFile, writeFile, rename, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { validNewPassword } from './accountValidation.js';
import { lockPreviewState } from './previewStateLock.js';

export async function setPreviewPassword({ directory, email, readPassword, adminOnly = true }) {
  email = email.trim().toLowerCase();
  const release = await lockPreviewState(directory);
  const file = join(directory, 'state.json');
  let temporaryWritten = false;
  try {
    const original = await readFile(file, 'utf8');
    const state = mongoose.mongo.BSON.EJSON.parse(original);
    if (state.version !== 1 || !Array.isArray(state.collections?.users)) throw new Error('Invalid isolated preview state.');
    const matches = state.collections.users.filter(row => String(row.email).trim().toLowerCase() === email);
    if (matches.length !== 1) throw new Error('One unambiguous existing local account is required; no account was changed.');
    const user = matches[0];
    if (adminOnly && user.role !== 'admin') throw new Error('Existing local administrator not found; no account was changed.');
    const [password, confirmation] = await readPassword();
    if (password !== confirmation) throw new Error('Passwords do not match; no account was changed.');
    if (!validNewPassword(password)) throw new Error('Password must contain at least 6 characters, not be blank, and use at most 72 UTF-8 bytes.');
    // Mutate only this hash; preserve IDs, roles, timestamps and all other data.
    user.password = await bcrypt.hash(password, 10);
    await copyFile(file, join(directory, `state-before-admin-reset-${Date.now()}.json`));
    // Remove the obsolete plaintext credential sidecar, if an older preview
    // wrote one. This changes no other account's password or role.
    await unlink(join(directory, 'admin-login.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await writeFile(file + '.tmp', mongoose.mongo.BSON.EJSON.stringify(state), { mode: 0o600 });
    temporaryWritten = true;
    await rename(file + '.tmp', file);
    temporaryWritten = false;
    return { email: user.email, role: user.role };
  } finally {
    if (temporaryWritten) await unlink(file + '.tmp').catch(() => {});
    await release();
  }
}
