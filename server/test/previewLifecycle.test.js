import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { closePreviewResources, listenPreviewServer } from '../scripts/preview-quick-catalog.js';

test('automatic preview port selection skips an occupied port without closing its server', async () => {
  const handler = (req, res) => res.end('ok');
  const first = await listenPreviewServer(handler, 0);
  let second;
  try {
    second = await listenPreviewServer(handler, first.address().port, true);
    assert.notEqual(first.address().port, second.address().port);
    assert.equal((await fetch(`http://127.0.0.1:${first.address().port}`)).status, 200);
  } finally {
    await new Promise(resolve => second ? second.close(resolve) : resolve());
    await new Promise(resolve => first.close(resolve));
  }
});

test('cleanup continues after HTTP, Vite and database failures, reporting each one', async () => {
  const calls = [], errors = [];
  const clean = await closePreviewResources({
    server: { close(callback) { calls.push('http'); callback(new Error('HTTP failed')); },
      closeAllConnections() { calls.push('connections'); } },
    vite: { async close() { calls.push('vite'); throw new Error('Vite failed'); } },
    preview: { async close() { calls.push('database'); throw new Error('ECONNREFUSED'); } },
  }, message => errors.push(message));
  assert.equal(clean, false);
  assert.deepEqual(calls, ['vite', 'http', 'connections', 'database']);
  assert.equal(errors.length, 3);
  assert.match(errors[2], /disposable database.*ECONNREFUSED/);
});

test('partial startup resources can be cleaned without masking the startup error', async () => {
  assert.equal(await closePreviewResources({}), true);
  let closed = false;
  assert.equal(await closePreviewResources({ preview: { async close() { closed = true; } } }), true);
  assert.equal(closed, true);
});

test('Windows npm preview survives stdin EOF, serves originals plus thirty samples, and handles SIGINT cleanly',
  { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rentsphere-preview-lifecycle-'));
    const marker = join(directory, 'stop');
    const preload = join(directory, 'signal.mjs');
    // Test-only signal delivery. Windows child.kill('SIGINT') forcibly terminates
    // Node instead of invoking its handler. No control endpoint is added to the app.
    await writeFile(preload, `import { existsSync } from 'node:fs';
if (process.argv[1]?.endsWith('preview-quick-catalog.js')) {
  const timer = setInterval(() => {
    if (existsSync(${JSON.stringify(marker)})) {
      clearInterval(timer);
      process.emit('SIGINT'); process.emit('SIGINT');
    }
  }, 100);
  timer.unref();
}
`);
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run preview:catalog'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
        RENTSPHERE_PREVIEW_PORT: '0', // Isolate parallel tests; interactive preview uses stable 5174.
        RENTSPHERE_PREVIEW_EPHEMERAL: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(preload).href}`,
      },
    });
    let output = '', exited = false;
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const exit = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
    });
    // A closed input pipe must not shut down the HTTP server.
    child.stdin.end();
    try {
      const deadline = Date.now() + 60000;
      while (!output.includes('Preview stays running until Ctrl+C.')) {
        assert.equal(exited, false, output);
        assert.ok(Date.now() < deadline, output);
        await delay(100);
      }
      const origin = output.match(/ISOLATED_PREVIEW_URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      assert.ok(origin, output);
      const login = await fetch(`${origin}/api/auth/login`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'demo@rentsphere.test', password: 'RentSphereDemo2026!' }) });
      assert.equal(login.status, 200);
      const session = await login.json();
      assert.ok(session.token);
      for (const type of ['property', 'vehicle']) {
        const response = await fetch(`${origin}/api/listings?type=${type}`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).length, type === 'property' ? 23 : 24);
      }
      const page = await fetch(origin);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<div id="root">/);
      const client = await fetch(`${origin}/@vite/client`);
      assert.equal(client.status, 200);
      assert.match(await client.text(), /WebSocket/);
      // Normal frontend reloads keep the database user and valid signing key.
      for (let reload = 0; reload < 2; reload++) {
        assert.equal((await fetch(origin)).status, 200);
        assert.equal((await fetch(`${origin}/api/bookings/mybookings`, {
          headers: { Authorization: `Bearer ${session.token}` },
        })).status, 200);
      }
      assert.equal((await fetch(`${origin}/api/bookings/mybookings`, {
        headers: { Authorization: 'Bearer invalid-test-token' },
      })).status, 401);
      await delay(20000);
      assert.equal(exited, false, output);
      assert.equal((await fetch(`${origin}/api/catalog-preview`)).status, 200);
      assert.equal((await fetch(`${origin}/api/bookings/mybookings`, {
        headers: { Authorization: `Bearer ${session.token}` },
      })).status, 200);
      await writeFile(marker, 'stop');
      const result = await Promise.race([exit, delay(20000, undefined, { ref: false }).then(() => { throw new Error('Shutdown timed out: ' + output); })]);
      assert.equal(result.code, 0, output);
      assert.equal((output.match(/Stopping catalog preview:/g) || []).length, 1, output);
      assert.doesNotMatch(output, /MongoServerSelectionError|ECONNREFUSED|cleanup failed|UnhandledPromiseRejection/);
      await assert.rejects(fetch(`${origin}/api/catalog-preview`));
      console.log('Windows npm command: 17 originals + 10 samples; HMR client; session survives refresh and idle; invalid token rejected; repeated SIGINT; exit 0.');
    } finally {
      if (!exited) {
        await writeFile(marker, 'stop');
        await Promise.race([exit, delay(10000, undefined, { ref: false })]);
        if (!exited) child.kill();
      }
      await unlink(marker).catch(() => {});
      await unlink(preload);
      await rmdir(directory);
    }
  });
