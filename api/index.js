// Loaded first so env vars are set before server.js (and db.js) evaluate. server.js
// also imports it, so this is belt-and-braces for the serverless entry point.
import '../server/env.js';
import app from '../server/server.js';

export default app;
