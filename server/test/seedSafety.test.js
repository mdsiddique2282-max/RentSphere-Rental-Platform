import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';

const seed = await readFile(new URL('../seed.js', import.meta.url), 'utf8');

// Execute the entry point only in an isolated context with fake environment
// values and blocked module/network/database access. Never load application env.
for (const [name, env] of [
  ['default execution', {}],
  ['development mode and opt-in flags', { NODE_ENV: 'development', ALLOW_SEED: 'true', CONFIRM_SEED: 'true' }],
  ['production mode', { NODE_ENV: 'production', ALLOW_SEED: 'true' }],
  ['Atlas-like configuration', { NODE_ENV: 'development', ALLOW_SEED: 'true', MONGODB_URI: 'mongodb+srv://fixture:fake@atlas.invalid/rentsphere' }],
  ['staging configuration', { RENTSPHERE_DATABASE_MODE: 'staging', ALLOW_SEED: 'true', RENTSPHERE_STAGING_URI: 'mongodb+srv://fixture:fake@atlas.invalid/rentsphere_staging' }],
  ['a database merely named disposable', { ALLOW_SEED: 'true', MONGODB_URI: 'mongodb://127.0.0.1:1/disposable_test' }],
  ['incomplete or invalid authorization', { ALLOW_SEED: 'yes', CONFIRM_SEED: '', MONGODB_URI: 'invalid-fixture-uri' }],
]) {
  test(`legacy seed refuses ${name} without loading modules, reading secrets or contacting a database`, () => {
    const messages = [], operations = [];
    const deny = operation => () => { operations.push(operation); throw new Error('Blocked test operation'); };
    const database = new Proxy({}, { get: (_, key) => deny(String(key)) });
    const processMock = { exitCode: 0, env: new Proxy(env, { get(target, key) { operations.push('environment read'); return target[key]; } }), exit: deny('process exit') };
    const context = createContext({
      process: processMock, console: { error: value => messages.push(value), log: deny('stdout') },
      require: deny('module load'), fetch: deny('network request'),
      mongoose: database, User: database, Listing: database, Booking: database,
    }, { codeGeneration: { strings: false, wasm: false } });
    const script = new Script(seed, { importModuleDynamically: deny('dynamic module load') });
    script.runInContext(context, { timeout: 1000 });
    assert.equal(processMock.exitCode, 1);
    assert.deepEqual(operations, []);
    assert.equal(messages.length, 1); assert.match(messages[0], /seeding is disabled/i);
    assert.doesNotMatch(messages[0], /mongodb:|mongodb\+srv:|fixture:fake/);
  });
}

test('normal startup and development scripts do not load the disabled seed entry point', async () => {
  for (const file of ['../server.js', '../db.js', '../env.js', '../scripts/dev-staging.js', '../../api/index.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:import|require)\s*(?:\(|[^;\n]*from\s*)?\s*['"][^'"]*seed\.js/);
  }
  for (const file of ['../package.json', '../../package.json']) {
    const pkg = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    for (const command of Object.values(pkg.scripts)) assert.doesNotMatch(command, /(?:^|[\s/\\])seed(?:\.js|\s|$)/);
  }
  // Any reintroduction of database or environment loading fails before execution.
  assert.doesNotMatch(seed, /\b(?:import|require|connect|deleteMany|dropDatabase|dropCollection|insertMany)\b/);
});
