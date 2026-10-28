import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Prevent two local preview processes/reset tools from overwriting saved users.
export async function lockPreviewState(directory) {
  const file = join(directory, 'active.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return async () => { await handle.close(); await unlink(file); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(await readFile(file, 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Preview state lock needs manual review.');
      try { process.kill(owner.pid, 0); }
      catch (check) {
        if (check.code === 'ESRCH') { await unlink(file); continue; }
      }
      throw new Error('This preview state is in use. Stop its existing preview with Ctrl+C before restarting or resetting a password.');
    }
  }
  throw new Error('Could not lock isolated preview state.');
}
