export const STAGING_DATABASE = 'rentsphere_staging';
export const STAGING_HOST = 'rentsphere.4pxgci7.mongodb.net';
export const STAGING_USER = 'rentsphere_staging_user';

// Pure validation: no DNS, network, logging, environment loading or DB access.
export function stagingConfig(env = process.env) {
  if (env.RENTSPHERE_DATABASE_MODE !== 'staging') throw new Error('Database access requires explicit staging mode. Production access is disabled.');
  const uri = env.RENTSPHERE_STAGING_URI;
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('A valid private RENTSPHERE_STAGING_URI is required.'); }
  const allowedOptions = new Set(['retryWrites', 'w', 'appName', 'authSource']);
  const keys = [...parsed.searchParams.keys()];
  if (parsed.protocol !== 'mongodb+srv:' || parsed.hostname !== STAGING_HOST || parsed.port || parsed.hash ||
      decodeURIComponent(parsed.pathname) !== '/' + STAGING_DATABASE ||
      decodeURIComponent(parsed.username) !== STAGING_USER || !parsed.password ||
      keys.some(key => !allowedOptions.has(key)) || new Set(keys).size !== keys.length ||
      (parsed.searchParams.has('authSource') && !['admin', STAGING_DATABASE].includes(parsed.searchParams.get('authSource'))) ||
      (parsed.searchParams.has('w') && parsed.searchParams.get('w') !== 'majority')) {
    throw new Error('Connection refused: only the approved staging host, staging username and rentsphere_staging database are allowed.');
  }
  return { uri, dbName: STAGING_DATABASE };
}
