import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { stagingConfig } from '../utils/stagingConfig.js';

// Deliberately does not load root .env or server/.env, which may target production.
try {
  let local = {};
  try { local = parse(await readFile(new URL('../.env.staging.local', import.meta.url))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const key of ['RENTSPHERE_STAGING_URI', 'JWT_SECRET', 'PORT', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'APP_BASE_URL', 'GEOAPIFY_API_KEY', 'MUMBAI_DELIVERY_BOUNDARY_FILE', 'MUMBAI_DELIVERY_BOUNDARY_SOURCE']) {
    if (process.env[key] === undefined && local[key] !== undefined) process.env[key] = local[key];
  }
  process.env.RENTSPHERE_DATABASE_MODE = 'staging';
  stagingConfig(); // Validate before importing the server or opening any socket.
  await import('../server.js');
} catch {
  console.error('Staging startup refused. Configure server/.env.staging.local with the staging-only URI and a strong JWT_SECRET. No production fallback is permitted.');
  process.exitCode = 1;
}
