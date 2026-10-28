import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canRecordPropertyInterest } from '../../src/data/propertyVisitAccess.js';

const accepted = { requestId: 'accepted-visit', status: 'confirmed', actionable: true, decision: null, token: 'customer-token', listingId: 'property-id' };
test('interest is hidden until an accepted undecided visit is verified for this exact account and property', () => {
  const allowed = record => canRecordPropertyInterest(record, 'customer-token', 'property-id');
  assert.equal(allowed(null), false); // Initial load/refresh, regardless of browser storage.
  for (const status of ['pending', 'rejected', 'cancelled']) assert.equal(allowed({ ...accepted, status }), false);
  assert.equal(allowed(accepted), true);
  for (const decision of ['interested', 'not-interested']) assert.equal(allowed({ ...accepted, decision }), false);
  assert.equal(allowed({ ...accepted, actionable: false }), false);
  for (const token of [undefined, '', 'another-account']) assert.equal(canRecordPropertyInterest(accepted, token, 'property-id'), false);
  assert.equal(canRecordPropertyInterest(accepted, 'customer-token', 'another-property'), false);
});

const source = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const effect = source.match(/useEffect\(\(\) => \{\s*let cancelled = false;\s*let sequence = 0;([\s\S]*?)\n  \}, \[item\?\._id, user\?\.token, isProperty, visitCheckVersion\]\);/);
assert.ok(effect, 'server-backed visit check effect must exist');
const runEffect = new Function('item', 'user', 'isProperty', 'visitCheckVersion', 'setVisitRecord', 'setVisitDecision', 'setDecisionShared', 'setDecisionSaving', 'setDecisionError', 'fetch', 'window',
  `let cancelled = false; let sequence = 0; ${effect[1]}`);
const flush = () => new Promise(resolve => setImmediate(resolve));
function startCheck(token = 'customer-token') {
  const records = [], pending = [], events = new Map();
  const window = { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
    setInterval: fn => { events.set('poll', fn); return 1; }, clearInterval: () => events.delete('poll') };
  const cleanup = runEffect({ _id: 'property-id' }, token ? { token } : null, true, 0, record => records.push(record),
    () => {}, () => {}, () => {}, () => {}, (url, options) => new Promise(resolve => pending.push({ url, options, resolve })), window);
  return { records, pending, events, cleanup };
}
test('visit checks hide interest while loading, recheck on focus without WhatsApp, and discard stale responses', async () => {
  const check = startCheck();
  assert.deepEqual(check.records, [null]);
  assert.equal(check.pending[0].url, '/api/preview/property-visits/property-id');
  assert.equal(check.pending[0].options.headers.Authorization, 'Bearer customer-token');
  check.pending[0].resolve({ ok: true, json: async () => ({ ...accepted, status: 'pending', actionable: false }) });
  await flush();
  assert.equal(canRecordPropertyInterest(check.records.at(-1), 'customer-token', 'property-id'), false);
  check.events.get('focus')();
  check.events.get('poll')();
  check.pending[2].resolve({ ok: true, json: async () => accepted });
  await flush();
  assert.equal(canRecordPropertyInterest(check.records.at(-1), 'customer-token', 'property-id'), true);
  check.pending[1].resolve({ ok: true, json: async () => ({ ...accepted, status: 'pending' }) });
  await flush();
  assert.equal(check.records.at(-1).status, 'confirmed');
  check.events.get('focus')();
  check.cleanup();
  check.pending[3].resolve({ ok: true, json: async () => accepted });
  const count = check.records.length;
  await flush();
  assert.equal(check.records.length, count);
  assert.equal(check.pending[3].options.signal.aborted, true);
  assert.equal(check.events.size, 0);
  assert.equal(canRecordPropertyInterest(check.records.at(-1), 'new-account-token', 'property-id'), false);
});
test('failed verification and logged-out state cannot display interest actions', async () => {
  const anonymous = startCheck(null);
  assert.deepEqual(anonymous.records, [null]); assert.equal(anonymous.pending.length, 0);
  const check = startCheck();
  check.pending[0].resolve({ ok: false }); await flush();
  assert.equal(check.records.at(-1), null);
  check.cleanup();
  assert.match(source, /visitRecord\?\.checkVersion === visitCheckVersion && canRecordPropertyInterest/);
  assert.match(source, /isProperty && visitRequested && visitDecision &&/);
});
