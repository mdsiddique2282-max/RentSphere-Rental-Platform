// A real UI/API preview backed ONLY by a new disposable MongoDB process.
// No URI arguments, no .env backend loader, and no production-server import.
import express from 'express';
import { previewPropertyWorkflow } from '../utils/previewPropertyWorkflow.js';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import authRoutes from '../routes/auth.js';
import listingRoutes from '../routes/listings.js';
import bookingRoutes from '../routes/bookings.js';
import ownerRoutes from '../routes/owner.js';
import adminRoutes from '../routes/admin.js';
import savedRoutes from '../routes/saved.js';
import { startQuickCatalogDatabase } from '../utils/quickCatalogPreview.js';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { verifyToken } from '../utils/tokens.js';
import { previewStateDirectory, previewProjectKey } from '../utils/finalCatalogPreview.js';

export async function listenPreviewServer(app, initialPort, allowFallback = false) {
  for (let offset = 0; offset < (allowFallback ? 10 : 1); offset++) {
    const server = createServer(app);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(initialPort + offset, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return server;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || !allowFallback || offset === 9) throw error;
    }
  }
}

// Attempt every cleanup step even when an earlier resource fails to close.
export async function closePreviewResources({ server, vite, preview }, report = console.error) {
  let failed = false;
  for (const [name, close] of [
    ['Vite', () => vite?.close()], // Close HMR websockets before waiting for HTTP connections.
    ['HTTP server', () => server && server.listening !== false && new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })],
    ['disposable database', () => preview?.close()],
  ]) {
    try { await close(); } catch (error) {
      failed = true;
      report('Preview cleanup failed (' + name + '): ' + error.message);
    }
  }
  return !failed;
}

export async function main() {
  const resources = {};
  let closing;
  const close = reason => closing ??= (async () => {
    console.log('Stopping catalog preview: ' + reason);
    if (!await closePreviewResources(resources)) process.exitCode = 1;
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
  })();
  const onInterrupt = () => { void close('Ctrl+C (SIGINT)'); };
  const onTerminate = () => { void close('SIGTERM'); };
  try {
    const app = express();
    const portFile = resolve(previewStateDirectory(), 'port.json');
    const automaticPort = process.env.RENTSPHERE_PREVIEW_PORT === undefined;
    let savedPort;
    if (automaticPort) {
      try { savedPort = JSON.parse(await readFile(portFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const port = Number(process.env.RENTSPHERE_PREVIEW_PORT ?? savedPort ?? 5174);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid RENTSPHERE_PREVIEW_PORT.');
    if (automaticPort) {
      try {
        const running = await (await fetch(`http://127.0.0.1:${port}/api/catalog-preview`, { signal: AbortSignal.timeout(1000) })).json();
        if (running.previewVersion === 'originals-plus-thirty-v2' && running.projectKey === previewProjectKey) {
          console.log(`Catalog preview already running: http://127.0.0.1:${port}`);
          return { reused: true, close: async () => {} };
        }
      } catch { /* An occupied unrelated/older server is left untouched. */ }
    }
    // Reserve the stable HTTP port before starting/restoring any preview database.
    const server = resources.server = await listenPreviewServer(app, port, automaticPort);
    resources.preview = await startQuickCatalogDatabase({ finalOnly: true,
      persist: process.env.RENTSPHERE_PREVIEW_EPHEMERAL !== '1',
      stateDirectory: process.env.RENTSPHERE_PREVIEW_STATE_DIR });
    const preview = resources.preview;
    app.use(express.json());
    app.use('/api/listings', (req, res, next) => {
      const json = res.json;
      const mark = row => {
        const plain = typeof row?.toObject === 'function' ? row.toObject() : row;
        // Correct shared legacy galleries in the preview response only; retain source records/photos.
        if (plain?.type === 'property' && !plain.inventoryKind && plain.image) return { ...plain, gallery: [plain.image], previewContext: 'catalog-isolated' };
        return plain?._id && ['property', 'vehicle'].includes(plain.type)
          ? { ...plain, previewContext: 'catalog-isolated' } : plain;
      };
      res.json = function (data) { return json.call(this, Array.isArray(data) ? data.map(mark) : mark(data)); };
      next();
    });
    app.use((req, res, next) => {
      if (req.method !== 'GET') res.on('finish', () => {
        if (res.statusCode < 400) preview.save().catch(error => console.error('Preview save failed:', error.message));
      });
      next();
    });
    app.use('/catalog-media', express.static(fileURLToPath(new URL('../../public/catalog-media/', import.meta.url))));
    app.use('/catalog-placeholders', express.static(fileURLToPath(new URL('../../public/catalog-placeholders/', import.meta.url))));
    app.get('/api/catalog-preview', (req, res) => res.json({ isolated: true, ...preview.counts,
      previewVersion: 'originals-plus-thirty-v2', projectKey: previewProjectKey,
      sampleInventory: true, liveImport: false, missingPhotoSets: 1, incompletePhotoKeys: ['M26'] }));
    // Old frontend URLs resolve to their isolated MongoDB copies. Production
    // routers and original source records are not edited.
    app.use('/api/listings', async (req, res, next) => {
      if (req.method === 'GET' && /^\/(RS|V)\d+$/.test(req.path)) {
        const listing = await mongoose.connection.db.collection('listings').findOne({ legacyId: req.path.slice(1) });
        if (listing) req.url = `/${listing._id}`;
      }
      next();
    });
    // Preview-only availability guard. Existing booking/visit APIs still perform
    // authentication, validation, duplicate prevention and price calculation.
    app.use('/api/bookings', async (req, res, next) => {
      if (req.method === 'POST' && ['/', '/visits'].includes(req.path) && mongoose.isObjectIdOrHexString(req.body?.listingId)) {
        let authenticated = false;
        try {
          const token = req.headers.authorization?.split(' ')[1];
          const actor = token && verifyToken(token);
          if (actor && await User.exists({ _id: actor.id })) {
            authenticated = true;
            const listing = await mongoose.connection.db.collection('listings').findOne({ _id: new mongoose.mongo.ObjectId(req.body.listingId) });
            if (listing?.status && listing.status !== 'available') return res.status(409).json({ message: 'This listing is unavailable for new requests.' });
          }
        } catch {
          if (authenticated) return res.status(503).json({ message: 'Availability could not be checked. Please try again.' });
          // Invalid credentials retain the existing authenticated API response.
        }
      }
      next();
    });
    app.use('/api/preview', previewPropertyWorkflow(preview));
    app.use('/api/auth', authRoutes);
    app.use('/api/listings', listingRoutes);
    app.use('/api/bookings', bookingRoutes);
    app.use('/api/owner', ownerRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/saved', savedRoutes);
    const root = fileURLToPath(new URL('../../', import.meta.url));
    resources.vite = await createViteServer({ root, configFile: false, plugins: [react(), {
      name: 'isolated-preview-marker', transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'rentsphere-isolated-preview', content: 'true' }, injectTo: 'head' }]
    }],
      // Frontend edits update the page without recreating users or JWT keys.
      // A stable origin also keeps browser storage on normal refresh/navigation.
      server: { middlewareMode: true, hmr: { server, host: '127.0.0.1' },
        watch: { ignored: ['**/server/**'] } }, appType: 'spa' });
    app.use(resources.vite.middlewares);
    if (automaticPort) {
      // Remember only a fully started preview, never a failed/aborted startup.
      await mkdir(previewStateDirectory(), { recursive: true });
      await writeFile(resolve(previewStateDirectory(), '.gitignore'), '*\n');
      await writeFile(portFile, JSON.stringify(server.address().port));
    }
    server.ref();
    console.log(`ISOLATED_PREVIEW_URL=http://127.0.0.1:${server.address().port}`);
    console.log('Demo account: demo@rentsphere.test (local preview only).');
    console.log(`${preview.counts.originalDatabase} original database listings + ${preview.counts.originalFrontend} original frontend listings + ${preview.counts.newProperties} new properties + ${preview.counts.newVehicles} new vehicles loaded. M26 photo incomplete. No live database connection or import.`);
    console.log('Choose a local admin password after stopping the preview: npm run preview:admin -- --set-password admin@rentsphere.com');
    process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
    console.log('Preview stays running until Ctrl+C. Closing terminal input does not stop it.');
    return { ...resources, close };
  } catch (error) {
    await close('startup failed');
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('Catalog preview failed:', error.message);
    process.exitCode = 1;
  });
}
