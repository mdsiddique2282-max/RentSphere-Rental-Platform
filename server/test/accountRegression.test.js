import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCurrentAccount, accountRefreshFailure, dashboardKind } from '../../src/data/account.js';

test('account verification rejects HTML and malformed responses cleanly without treating proxy HTML as invalid credentials', async () => {
  for (const status of [200, 401, 404, 502]) {
    await assert.rejects(fetchCurrentAccount('mock-only', async (url, options) => {
      assert.equal(url, '/api/auth/me'); assert.equal(options.headers.Accept, 'application/json');
      return new Response('<!DOCTYPE html><pre>Cannot GET /api/auth/me</pre>', { status, headers: { 'Content-Type': 'text/html' } });
    }), error => !error.message.includes('<') && /temporarily unavailable/.test(error.message) && error.status !== 401);
  }
  for (const body of ['', '{', 'null', '[]']) await assert.rejects(fetchCurrentAccount('mock-only', async () => new Response(body, { headers: { 'Content-Type': 'application/json' } })), /temporarily unavailable/);
  await assert.rejects(fetchCurrentAccount('mock-only', async () => { throw new Error('network details'); }), /temporarily unavailable/);
  await assert.rejects(fetchCurrentAccount('mock-only', async () => new Response(JSON.stringify({ message: 'Please log in again.' }), { status: 401, headers: { 'Content-Type': 'application/json' } })), { status: 401 });
});

test('retry recovers a failed request with authoritative user, approved-owner and admin identity', async () => {
  for (const role of ['user', 'owner', 'admin']) {
    const account = { _id: role + '-fixture', role, ownerProfile: { status: 'approved' } };
    let attempts = 0;
    const fetcher = async () => ++attempts === 1 ? new Response('<!DOCTYPE html>', { status: 404, headers: { 'Content-Type': 'text/html' } })
      : new Response(JSON.stringify(account), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    await assert.rejects(fetchCurrentAccount('mock-only', fetcher), /temporarily unavailable/);
    assert.deepEqual(await fetchCurrentAccount('mock-only', fetcher), account);
    assert.equal(dashboardKind(account), role);
  }
});

test('transient failure preserves only the same session previously verified identity and never substitutes a default role', () => {
  for (const role of ['user', 'owner', 'admin']) {
    const account = { _id: role, role, ownerProfile: { status: 'approved' } };
    const failed = accountRefreshFailure({ status: 'ready', account, token: 'session-a' }, 'session-a', 'Please retry.');
    assert.equal(failed.account, account); assert.equal(dashboardKind(failed.account), role); assert.equal(failed.status, 'error');
    assert.equal(accountRefreshFailure(failed, 'session-b', 'Please retry.').account, null);
    assert.equal(accountRefreshFailure({ token: 'session-a', account: null }, 'session-a', 'Please retry.').account, null);
  }
  assert.equal(dashboardKind({ role: 'owner', ownerProfile: { status: 'pending' } }), 'user');
  assert.equal(dashboardKind({ role: 'owner', ownerProfile: { status: 'rejected' } }), 'user');
});
