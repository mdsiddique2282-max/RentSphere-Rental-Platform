// Loads environment variables BEFORE any other backend module is evaluated.
//
// Why this file exists: with ES module imports, every `import ... from '...'` at the
// top of server.js is resolved and evaluated BEFORE server.js's own top-level code runs.
// db.js used to read `process.env.MONGODB_URI` at module load time, so even though
// server.js called dotenv.config() further down, that call happened too late - db.js
// had already cached `undefined` (or a hardcoded fallback) for MONGODB_URI.
//
// Fix: this module is imported FIRST (as a plain side-effect import, before any other
// import) in every backend entry point (server.js, api/index.js), so dotenv.config()
// genuinely runs before db.js or any route file is evaluated.
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Root .env first, then server/.env (server/.env can override project-root values).
// Neither file is required to exist locally - in production (e.g. Vercel) environment
// variables are provided by the platform instead of a file, and dotenv.config() simply
// no-ops when the file is missing.
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '.env'), override: true });
