import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer, transformWithOxc } from 'vite';
import react from '@vitejs/plugin-react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFile } from 'node:fs/promises';
import { hostingFixture } from './helpers/hostingFixture.js';
import { hostingValues, validateHosting, hostingChoiceOptions, hostingChoiceKey, addHostingChoice, propertyCategories } from '../../src/data/hosting.js';
import { removeHistoryRequest } from '../../src/data/requestHistory.js';
import { dashboardKind } from '../../src/data/account.js';

let vite, AuthContext;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envDir: false,
    plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  ({ AuthContext } = await vite.ssrLoadModule('/src/context/AuthContext.jsx'));
});

test('admin request management has accurate counts/search, detailed cards, pending-only actions and responsive sections', async () => {
  const { AdminRequestCard, default: AdminRequests, adminRequestCounts, filterAdminRequests } = await vite.ssrLoadModule('/src/components/AdminRequests.jsx');
  const base = { _id: 'admin-ui-request', requestType: 'vehicle', status: 'pending', startDate: '2098-01-10', endDate: '2098-01-12', createdAt: '2098-01-01T10:00:00Z',
    listing: { title: 'Premium fixture vehicle', type: 'vehicle', category: 'SUV', kind: 'Car', location: 'Mumbai', price: 1200, image: '/fixture.jpg', phone: '9876543210', host: { name: 'Listing Owner', email: 'owner@example.test' } },
    user: { name: 'Customer Account', email: 'account@example.test' }, contact: { name: 'Requesting Customer', email: 'customer@example.test', phone: '9876543210' },
    fulfilment: 'delivery', deliveryAddress: 'Complete delivery address', deliveryCharge: 300, totalPrice: 2700 };
  const rows = ['pending', 'confirmed', 'rejected', 'cancelled'].map((status, index) => ({ ...base, _id: 'row-' + index, status }));
  assert.deepEqual(adminRequestCounts(rows), { total: 4, pending: 1, confirmed: 1, rejected: 1 });
  for (const search of ['PREMIUM', 'requesting customer', 'Customer Account', 'Listing Owner']) assert.equal(filterAdminRequests(rows, search, 'all').length, 4);
  assert.equal(filterAdminRequests(rows, '', 'pending').length, 1); assert.equal(filterAdminRequests(rows, 'missing', 'all').length, 0);
  for (const status of ['pending', 'confirmed', 'rejected', 'cancelled']) {
    const html = render(AdminRequestCard, { row: { ...base, status }, vehicle: true, onDecide() {} });
    for (const text of ['Premium fixture vehicle', 'Listing Owner', 'Requesting Customer', 'customer@example.test', '9876543210', 'SUV', 'Home Delivery', 'Complete delivery address', '2 days', '₹2,700', '₹300', 'Created']) assert.ok(html.includes(text), text);
    assert.equal(html.includes('>Accept<'), status === 'pending'); assert.equal(html.includes('>Reject<'), status === 'pending');
    assert.equal(html.includes('>Manage<'), ['pending', 'confirmed', 'rejected'].includes(status));
  }
  const visit = { ...base, listing: { ...base.listing, type: 'property', category: 'Apartment' }, propertyDecision: { kind: 'interested' } };
  const visitHtml = render(AdminRequestCard, { row: visit, vehicle: false, onDecide() {} });
  for (const text of ['Monthly rent', 'Requested visit date', 'Interested']) assert.ok(visitHtml.includes(text));
  assert.doesNotMatch(visitHtml, /Delivery address|Daily rent|Fulfilment/);
  const ownerless = render(AdminRequestCard, { row: { ...base, listing: { ...base.listing, host: null } }, vehicle: true, onDecide() {} });
  assert.match(ownerless, /Admin-managed \/ predefined/);
  assert.match(render(AdminRequestCard, { row: { ...base, listing: null, user: null }, vehicle: true, onDecide() {} }), /Historical listing/);
  const busy = render(AdminRequestCard, { row: base, vehicle: true, busy: true, processing: 'confirm', onDecide() {} });
  assert.match(busy, /Processing/); assert.equal((busy.match(/disabled=""/g) || []).length, 3);
  let decision;
  const card = AdminRequestCard({ row: base, vehicle: true, onDecide: (row, action) => { decision = [row._id, action]; } });
  const actions = card.props.children.at(-1).props.children[1].props.children;
  actions[0].props.onClick(); assert.deepEqual(decision, [base._id, 'confirm']);
  actions[1].props.onClick(); assert.deepEqual(decision, [base._id, 'reject']);
  for (const vehicle of [true, false]) {
    let managed;
    const row = { ...base, listing: { ...base.listing, type: vehicle ? 'vehicle' : 'property' } };
    const pending = AdminRequestCard({ row, vehicle, onDecide() {}, onManage: value => { managed = value; } });
    const buttons = pending.props.children.at(-1).props.children[1].props.children;
    assert.deepEqual(buttons.map(button => button.props.children), ['Accept', 'Reject', 'Manage']);
    buttons[2].props.onClick(); assert.equal(managed, row);
  }
  for (const type of ['vehicle', 'property_visit']) {
    const html = render(AdminRequests, { type }, '/admin', { role: 'admin', token: 'mock-only' });
    assert.match(html, type === 'vehicle' ? /Vehicle Bookings/ : /Property Visits/);
    assert.match(html, /Manage .* requests across RentSphere/); assert.match(html, /Loading/);
    for (const text of ['Total Requests', 'Pending', 'Confirmed', 'Rejected', 'Search requests', 'Status', 'Refresh']) assert.ok(html.includes(text));
  }
  const source = await readFile(new URL('../../src/components/AdminPanel.jsx', import.meta.url), 'utf8');
  const sidebar = source.slice(source.indexOf('{/* Sidebar Navigation */}'), source.indexOf('{/* Main Content Area */}'));
  const order = ["setActiveTab('overview')", "setActiveTab('users')", "setActiveTab('products')", "['vehicle_bookings', 'Vehicle Bookings']", "['property_visits', 'Property Visits']", "setActiveTab('add_product')", "setActiveTab('owners')"].map(text => sidebar.indexOf(text));
  assert.ok(order.every(index => index >= 0)); assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(source, /AdminRequests key="vehicle" type="vehicle"/); assert.match(source, /AdminRequests key="property_visit" type="property_visit"/);
  assert.match(source, /All Products \(/);
  const css = await readFile(new URL('../../src/components/AdminRequests.css', import.meta.url), 'utf8');
  assert.match(css, /@media\(max-width:1100px\)/); assert.match(css, /@media\(max-width:600px\)/); assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /\.admin-request-list\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);grid-auto-flow:row\}/);
  assert.match(css, /container-type:inline-size/);
  assert.match(css, /@container\(max-width:780px\)\{\.admin-request-list\{grid-template-columns:1fr\}\}/);
  const ordered = [{ ...base, _id: 'newest', status: 'pending' }, { ...base, _id: 'middle', status: 'confirmed' }, { ...base, _id: 'oldest', status: 'pending' }];
  assert.deepEqual(filterAdminRequests(ordered, 'premium', 'all').map(row => row._id), ['newest', 'middle', 'oldest']);
  assert.deepEqual(filterAdminRequests(ordered, '', 'pending').map(row => row._id), ['newest', 'oldest']);
  for (const component of ['OwnerRequests', 'CustomerRequests']) {
    const requestSource = await readFile(new URL(`../../src/components/${component}.jsx`, import.meta.url), 'utf8');
    assert.doesNotMatch(requestSource, /\.reverse\(|\.sort\(/);
    assert.match(requestSource, /shown.map\(row =>/);
  }
});

test('admin Manage dialog provides safe listing-level controls, archive confirmation, restore and accessible viewport layout', async () => {
  const { AdminRequestCard } = await vite.ssrLoadModule('/src/components/AdminRequests.jsx');
  const { default: Manage } = await vite.ssrLoadModule('/src/components/AdminRequestManage.jsx');
  const row = { _id: 'request', status: 'confirmed', listing: { _id: 'listing', title: 'Managed property', type: 'property' }, contact: { name: 'Request customer' } };
  let selected;
  const card = AdminRequestCard({ row, onManage: value => { selected = value; } });
  card.props.children.at(-1).props.children[2].props.onClick(); assert.equal(selected, row);
  for (const hiddenFromAdmin of [false, true]) {
    const html = render(Manage, { row: { ...row, hiddenFromAdmin }, token: 'mock-only', onClose() {}, readResponse() {} });
    for (const text of ['Manage Request', 'Managed property', 'Request customer', 'Confirmed', 'Listing Availability', 'Checking availability', 'aria-modal="true"', 'role="dialog"', 'aria-labelledby=', 'Close Manage Request']) assert.ok(html.includes(text), text);
    assert.match(html, hiddenFromAdmin ? /Restore Request/ : /Archive\/Delete Request/);
    assert.equal((html.match(/disabled=""/g) || []).length, 2, 'availability controls disabled until authoritative listing loads');
    assert.doesNotMatch(html, />Accept<|>Reject</);
  }
  const source = await readFile(new URL('../../src/components/AdminRequestManage.jsx', import.meta.url), 'utf8');
  assert.match(source, /createPortal\(content, document.body\)/);
  assert.match(source, /event.key === 'Escape'/); assert.match(source, /event.key !== 'Tab'/);
  assert.match(source, /trigger\?\.isConnected/); assert.match(source, /Confirm archive/);
  assert.match(source, /JSON.stringify\(\{ available \}\)/); assert.match(source, /JSON.stringify\(\{ archived \}\)/);
  const css = await readFile(new URL('../../src/components/AdminRequests.css', import.meta.url), 'utf8');
  assert.match(css, /@media\(min-width:769px\)\{\.admin-navigation-sidebar\{position:sticky;top:96px/);
  assert.match(css, /max-height:calc\(100dvh - 32px\);overflow-y:auto/);
});

test('admin action UI prevents duplicate clicks, reports genuine failures, refreshes conflicts and ignores switched sessions', async () => {
  const source = await readFile(new URL('../../src/components/AdminRequests.jsx', import.meta.url), 'utf8');
  const handler = source.match(/const decide = async \(row, action\) => \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(handler);
  const createDecide = new Function('deps', `with (deps) { ${handler}; return decide; }`);
  for (const mode of ['success', 'failure', 'conflict', 'switch']) {
    const row = { _id: 'action-id', status: 'pending' }, notices = [], errors = [];
    let resolve, calls = 0, refreshes = 0, snapshot = { scope: 'session', rows: [row] };
    const waiting = new Promise(done => { resolve = done; });
    const deps = { user: { role: 'admin', token: 'mock-only' }, scope: 'session', scopeRef: { current: 'session' }, actionLock: { current: false },
      setBusy() {}, setError: value => errors.push(value), setNotice: value => notices.push(value), setSnapshot: fn => { snapshot = fn(snapshot); },
      fetch: async (url, options) => { calls++; assert.equal(url, '/api/admin/requests/action-id/confirm'); assert.equal(options.method, 'PUT'); return waiting; },
      readResponse: async response => { if (response.fail) throw Object.assign(new Error('Decision failed'), { status: response.status }); return response; },
      load: async () => { refreshes++; return true; } };
    const decide = createDecide(deps), first = decide(row, 'confirm');
    await decide(row, 'confirm'); assert.equal(calls, 1);
    if (mode === 'switch') deps.scopeRef.current = 'another-session';
    resolve(mode === 'failure' || mode === 'conflict' ? { fail: true, status: mode === 'conflict' ? 409 : 503 } : { _id: row._id, status: 'confirmed' });
    await first;
    if (mode === 'success') { assert.equal(snapshot.rows[0].status, 'confirmed'); assert.ok(notices.includes('Request accepted successfully.')); assert.equal(refreshes, 1); }
    else if (mode === 'switch') { assert.equal(snapshot.rows[0].status, 'pending'); assert.equal(refreshes, 0); assert.ok(!notices.includes('Request accepted successfully.')); }
    else { assert.equal(snapshot.rows[0].status, 'pending'); assert.ok(!notices.includes('Request accepted successfully.')); assert.equal(refreshes, 1); assert.ok(errors.at(-1).includes('Decision failed')); }
  }
});

test('Manage archive requires confirmation, blocks double submission and only reports verified server success', async () => {
  const source = await readFile(new URL('../../src/components/AdminRequestManage.jsx', import.meta.url), 'utf8');
  const handler = source.match(/const archive = async \(\) => \{[\s\S]*?\n  \};/)?.[0]; assert.ok(handler);
  const create = new Function('deps', `with (deps) { ${handler}; return archive; }`);
  for (const mode of ['archive', 'restore', 'failure', 'invalid-response']) {
    let complete, calls = 0, result;
    const errors = [], pending = new Promise(resolve => { complete = resolve; });
    const deps = { row: { _id: 'request', hiddenFromAdmin: mode === 'restore' }, token: 'mock-only', confirmArchive: false,
      locked: { current: false }, mounted: { current: true }, setBusy() {}, setError: error => errors.push(error), setNotice() {},
      fetch: async (url, options) => { calls++; assert.equal(url, '/api/admin/requests/request/archive'); assert.deepEqual(JSON.parse(options.body), { archived: mode !== 'restore' }); return pending; },
      readResponse: async response => { if (mode === 'failure') throw new Error('Archive failed'); return response; }, onArchived: async archived => { result = archived; } };
    const archive = create(deps);
    if (mode !== 'restore') { await archive(); assert.equal(calls, 0); deps.confirmArchive = true; }
    const first = archive(); await archive(); assert.equal(calls, 1);
    complete({ _id: mode === 'invalid-response' ? 'wrong-request' : 'request', archived: mode !== 'restore' }); await first;
    assert.equal(deps.locked.current, false);
    if (['failure', 'invalid-response'].includes(mode)) { assert.equal(result, undefined); assert.ok(errors.at(-1)); }
    else assert.equal(result, mode !== 'restore');
  }
});

test('bulk archive selection stays within current filters and active section; cards and custom confirmation are accessible', async () => {
  const { filterAdminRequests, selectedAdminRequestIds, AdminRequestCard, AdminArchiveConfirmation } = await vite.ssrLoadModule('/src/components/AdminRequests.jsx');
  const rows = [
    { _id: 'pending', status: 'pending', listing: { title: 'Mumbai Home' } },
    { _id: 'confirmed', status: 'confirmed', listing: { title: 'Mumbai Flat' } },
    { _id: 'rejected', status: 'rejected', listing: { title: 'Pune Flat' } },
    { _id: 'archived', status: 'pending', listing: { title: 'Mumbai Home' }, hiddenFromAdmin: true },
  ];
  const ids = [...rows.map(row => row._id), 'other-section'];
  assert.deepEqual(selectedAdminRequestIds(filterAdminRequests(rows, 'Mumbai', 'all'), ids), ['pending', 'confirmed']);
  assert.deepEqual(selectedAdminRequestIds(filterAdminRequests(rows, '', 'rejected'), ids), ['rejected']);
  assert.deepEqual(selectedAdminRequestIds(rows, []), []);
  const many = Array.from({ length: 1500 }, (_, i) => ({ _id: String(i) }));
  assert.equal(selectedAdminRequestIds(many, many.map(row => row._id)).length, 1500, 'no artificial limit');
  for (const vehicle of [true, false]) {
    let selected;
    const row = { ...rows[0], listing: { ...rows[0].listing, type: vehicle ? 'vehicle' : 'property' } };
    const card = AdminRequestCard({ row, vehicle, selecting: true, selected: true, onSelect: id => { selected = id; } });
    card.props.children[0].props.children[0].props.onChange(); assert.equal(selected, row._id);
    const html = render(AdminRequestCard, { row, vehicle, selecting: true, selected: true, onSelect() {} });
    assert.match(html, /type="checkbox" checked=""/); assert.match(html, /admin-request-card is-selected/);
    assert.match(html, />Accept<.*>Reject<.*>Manage</);
    assert.doesNotMatch(render(AdminRequestCard, { row: { ...row, hiddenFromAdmin: true }, vehicle, selecting: true }), /type="checkbox"/);
  }
  for (const busy of [false, true]) {
    const html = render(AdminArchiveConfirmation, { count: 15, progress: 4, busy, onClose() {}, onConfirm() {} });
    assert.match(html, /Archive\/Delete Selected Requests/); assert.match(html, /Archive\/Delete 15 selected requests/);
    assert.match(html, /You can restore these requests later/); assert.match(html, /role="dialog" aria-modal="true"/);
    assert.equal((html.match(/disabled=""/g) || []).length, busy ? 2 : 0);
    assert.match(html, busy ? /Archiving 4 of 15/ : /Archive\/Delete 15 Requests/);
  }
  const source = await readFile(new URL('../../src/components/AdminRequests.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /window.confirm/);
  assert.match(source, /setSearch\(e.target.value\); clearSelection\(\)/);
  assert.match(source, /setStatus\(e.target.value\); clearSelection\(\)/);
  assert.match(source, /clearSelection\(\); setSelecting\(false\)/);
  const css = await readFile(new URL('../../src/components/AdminRequests.css', import.meta.url), 'utf8');
  assert.match(css, /html:has\(\.admin-grid\),body:has\(\.admin-grid\)\{overflow-x:clip\}/);
  assert.match(css, /\.admin-bulk-toolbar\{[^}]*flex-wrap:wrap/);
  const panel = await readFile(new URL('../../src/components/AdminPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /className="admin-request-nav-icon" aria-hidden="true"/);
  assert.match(panel, /'🚘' : '🏡'/);
});

test('bulk archive reuses the existing API sequentially, reports partial failures and stops on session changes', async () => {
  const { archiveAdminRequests } = await vite.ssrLoadModule('/src/components/AdminRequests.jsx');
  const calls = [], progress = []; let active = 0, peak = 0;
  const result = await archiveAdminRequests({ ids: ['pending', 'confirmed', 'rejected', 'pending'], token: 'mock-only', isCurrent: () => true,
    onProgress: value => progress.push(value), send: async (url, options) => {
      active++; peak = Math.max(peak, active); calls.push(url);
      assert.equal(options.method, 'PUT'); assert.deepEqual(JSON.parse(options.body), { archived: true });
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      const id = url.split('/').at(-2);
      return new Response(JSON.stringify(id === 'confirmed' ? { message: 'Request changed' } : { _id: id, archived: true }), { status: id === 'confirmed' ? 409 : 200, headers: { 'Content-Type': 'application/json' } });
    } });
  assert.equal(peak, 1); assert.equal(calls.length, 3);
  assert.deepEqual(result.succeeded, ['pending', 'rejected']); assert.deepEqual(result.failed, [{ id: 'confirmed', message: 'Request changed' }]);
  assert.deepEqual(progress, [1, 2, 3]);
  for (const failure of ['forbidden', 'html', 'unverified', 'network']) {
    const failed = await archiveAdminRequests({ ids: ['pending'], token: 'mock-only', isCurrent: () => true, onProgress() {}, send: async () => {
      if (failure === 'network') throw new Error('Offline');
      return failure === 'html' ? new Response('<html>Error</html>', { status: 503 }) : new Response(JSON.stringify(failure === 'forbidden' ? { message: 'Admin access required' } : { _id: 'wrong', archived: true }), { status: failure === 'forbidden' ? 403 : 200, headers: { 'Content-Type': 'application/json' } });
    } });
    assert.equal(failed.succeeded.length, 0); assert.equal(failed.failed.length, 1);
  }
  let current = true, switchedCalls = 0;
  await archiveAdminRequests({ ids: ['first', 'second'], token: 'mock-only', isCurrent: () => current, onProgress() {}, send: async () => {
    switchedCalls++; current = false;
    return new Response(JSON.stringify({ _id: 'first', archived: true }), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(switchedCalls, 1);
});

test('bulk submit requires confirmation, prevents double submission and retains failed requests for retry', async () => {
  const source = await readFile(new URL('../../src/components/AdminRequests.jsx', import.meta.url), 'utf8');
  const handler = source.match(/const bulkArchive = async \(\) => \{[\s\S]*?\n  \};/)?.[0]; assert.ok(handler);
  const create = new Function('deps', `with (deps) { ${handler}; return bulkArchive; }`);
  let finish, calls = 0, selection, selecting, notice, error, refreshes = 0;
  let snapshot = { scope: 'admin', rows: [{ _id: 'ok' }, { _id: 'failed' }] };
  const pending = new Promise(resolve => { finish = resolve; });
  const deps = { actionLock: { current: false }, confirmBulk: false, archived: false, loading: false, selectedIds: ['ok', 'failed'], user: { role: 'admin', token: 'mock-only' },
    scope: 'admin', scopeRef: { current: 'admin' }, selectionKey: 'filter-key', setBusy() {}, setProgress() {}, setBulkTotal() {}, setConfirmBulk() {},
    setNotice: value => { notice = value; }, setBulkError: value => { error = value; }, setSelection: value => { selection = value; }, setSelecting: value => { selecting = value; },
    setSnapshot: fn => { snapshot = fn(snapshot); }, load: async () => { refreshes++; }, archiveAdminRequests: async () => { calls++; return pending; } };
  const submit = create(deps);
  await submit(); assert.equal(calls, 0);
  deps.confirmBulk = true; const first = submit(); await submit(); assert.equal(calls, 1);
  finish({ succeeded: ['ok'], failed: [{ id: 'failed', message: 'Request changed' }] }); await first;
  assert.equal(deps.actionLock.current, false); assert.equal(refreshes, 1);
  assert.deepEqual(snapshot.rows, [{ _id: 'failed' }]); assert.deepEqual(selection.ids, ['failed']); assert.equal(selecting, true);
  assert.match(error, /1 requests archived successfully\. 1 failed/); assert.equal(notice, '');
});

test('archived selection and Delete confirmations preserve active archive controls and expose exact counts', async () => {
  const { selectedAdminRequestIds, AdminRequestCard, AdminArchiveConfirmation } = await vite.ssrLoadModule('/src/components/AdminRequests.jsx');
  const rows = [{ _id: 'a', status: 'pending', hiddenFromAdmin: true, listing: { title: 'Archived listing' } }, { _id: 'active', status: 'pending' }];
  assert.deepEqual(selectedAdminRequestIds(rows, ['a', 'active'], true), ['a']);
  for (const vehicle of [true, false]) {
    let selected;
    const card = AdminRequestCard({ row: rows[0], vehicle, selecting: true, archivedSelection: true, selected: true, onSelect: id => { selected = id; } });
    card.props.children[0].props.children[0].props.onChange(); assert.equal(selected, 'a');
    const html = render(AdminRequestCard, { row: rows[0], vehicle, selecting: true, archivedSelection: true, selected: true });
    assert.match(html, /type="checkbox" checked=""/); assert.match(html, />Manage</);
  }
  for (const all of [false, true]) {
    const html = render(AdminArchiveConfirmation, { deleting: true, all, count: 45, busy: false, onClose() {}, onConfirm() {} });
    assert.match(html, all ? /Delete ALL 45 archived requests/ : /Delete 45 archived requests/);
    assert.match(html, all ? /Delete All 45 Requests/ : /Delete 45 Requests/);
    assert.match(html, /role="dialog" aria-modal="true"/); assert.doesNotMatch(html, /You can restore these requests later/);
  }
});

test('admin product filters preserve order, combine type/name search and render accurate readable tabs', async () => {
  const { filterAdminProducts, adminListingPath, AdminProductFilters } = await vite.ssrLoadModule('/src/components/AdminPanel.jsx');
  const products = [{ _id: 'home-1', type: 'property', title: 'Mumbai Apartment' }, { _id: 'car-1', type: 'vehicle', name: 'Mumbai Car' }, { _id: 'home-2', type: 'property', name: 'Pune Studio' }];
  assert.deepEqual(filterAdminProducts(products, 'all', '').map(row => row._id), ['home-1', 'car-1', 'home-2']);
  assert.deepEqual(filterAdminProducts(products, 'property', ' MUMBAI ').map(row => row._id), ['home-1']);
  assert.deepEqual(filterAdminProducts(products, 'vehicle', ' mUmBaI ').map(row => row._id), ['car-1']);
  assert.equal(filterAdminProducts(products, 'vehicle', '').length, 1); assert.equal(filterAdminProducts(products, 'property', 'missing').length, 0);
  assert.equal(adminListingPath(products[0]), '/properties/home-1'); assert.equal(adminListingPath(products[1]), '/vehicles/car-1');
  for (const type of ['all', 'property', 'vehicle']) {
    const html = render(AdminProductFilters, { products, type, search: '', onTypeChange() {}, onSearchChange() {} });
    for (const text of ['All Products (3)', 'Properties (2)', 'Vehicles (1)', 'Search properties or vehicles by name...']) assert.ok(html.includes(text));
    assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  }
  let selected, search;
  const filters = AdminProductFilters({ products, type: 'all', search: '', onTypeChange: value => { selected = value; }, onSearchChange: value => { search = value; } });
  filters.props.children[0].props.children[1].props.onClick(); assert.equal(selected, 'property');
  filters.props.children[1].props.children[1].props.onChange({ target: { value: 'Pune' } }); assert.equal(search, 'Pune');
  const source = await readFile(new URL('../../src/components/AdminPanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /<HostingForm token=\{user.token\}/); assert.doesNotMatch(source, /submitAdminProduct|setProductForm/);
  assert.match(source, /to=\{adminListingPath\(p\)\} target="_blank" rel="noopener noreferrer"/);
  assert.match(source, /<ListingControls item=\{p\} onChanged=\{loadAdminData\}/);
  assert.match(source, /onClick=\{\(\) => handleDeleteProduct\(p._id, p.title \|\| p.name\)\}/);
  assert.match(source, /No matching products found/);
  const css = await readFile(new URL('../../src/index.css', import.meta.url), 'utf8');
  assert.match(css, /\.admin-product-tab.is-active\{background:#245fca;color:#fff/);
  assert.match(css, /\.admin-product-tab\{[^}]*background:#fff;color:#174ea6/);
  assert.match(css, /\.admin-product-tab:focus-visible/);
});

test('shared HostingForm blocks duplicate submissions while keeping the existing multipart publish workflow', async () => {
  const source = await readFile(new URL('../../src/components/HostingForm.jsx', import.meta.url), 'utf8');
  const handler = source.match(/const submit = async e => \{[\s\S]*?\n  \};/)?.[0]; assert.ok(handler);
  const create = new Function('deps', `with (deps) { ${handler}; return submit; }`);
  let calls = 0, saved = 0, finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const deps = { allowedTypes: ['property','vehicle'], submitLock: { current: false }, form: hostingFixture(), retained: [], uploads: [{ file: new Blob(['fixture'], { type: 'image/png' }) }], item: null, token: 'mock-only',
    validateHostingLocation: async () => {}, validateHosting, hostingValues, FormData, fileInput: { current: null }, setBusy() {}, setError() {}, setSuccess() {}, setForm() {}, setUploads() {}, setRetained() {}, onBusyChange() {},
    onSaved: async () => { saved++; }, fetch: async (url, options) => { calls++; assert.equal(url, '/api/listings'); assert.equal(options.method, 'POST'); assert.equal(options.body.getAll('images').length, 1); return waiting; } };
  const submit = create(deps), event = { preventDefault() {} };
  const first = submit(event); await submit(event); assert.equal(calls, 1);
  finish({ ok: true, json: async () => ({ _id: 'created' }) }); await first;
  assert.equal(saved, 1); assert.equal(deps.submitLock.current, false);
});

test('shared map picker preloads saved coordinates and is available in both property and vehicle forms', async () => {
  const { default: Picker } = await vite.ssrLoadModule('/src/components/MapLocationPicker.jsx');
  const { HostingFields } = await vite.ssrLoadModule('/src/components/HostingForm.jsx');
  const pin = { lat: 19.123456789, lon: 72.987654321 };
  const empty = render(Picker, { onClose() {}, onConfirm() {} });
  assert.match(empty, /No pin selected/); assert.match(empty, /disabled=""[^>]*>Confirm Location/);
  assert.match(empty, /role="dialog" aria-modal="true"/); assert.match(empty, /Choose map centre/);
  const saved = render(Picker, { initialCoordinates: pin, initialAddress: 'Saved pickup address', onClose() {}, onConfirm() {} });
  assert.match(saved, /Selected pin: 19.123457, 72.987654/); assert.match(saved, /Saved pickup address/);
  assert.doesNotMatch(saved, /disabled=""[^>]*>Confirm Location/);
  for (const type of ['property', 'vehicle']) {
    const html = render(HostingFields, { form: hostingValues(hostingFixture(type)), setForm() {} });
    assert.equal(html.includes('Choose Location on Map'), true);
  }
  const source = await readFile(new URL('../../src/components/MapLocationPicker.jsx', import.meta.url), 'utf8');
  for (const pattern of [/draggable: true/, /view.on\('click'/, /marker.current\?\.off\(\)/, /map.current\?\.remove\(\)/, /abort.current\?\.abort\(\)/, /stopPropagation\(\)/, /createPortal\(content, document.body\)/]) assert.match(source, pattern);
  const css = await readFile(new URL('../../src/components/MapLocationPicker.css', import.meta.url), 'utf8');
  assert.match(css, /100dvh/); assert.match(css, /@media\(max-width:600px\)/);
});

test('new map pins preserve full precision and stale reverse responses cannot replace a later selection', async () => {
  const source = await readFile(new URL('../../src/components/MapLocationPicker.jsx', import.meta.url), 'utf8');
  const handler = source.match(/const resolve = useCallback\(async selected => \{[\s\S]*?\n  \}, \[\]\);/)?.[0]; assert.ok(handler);
  const create = new Function('deps', `with(deps) { ${handler}; return resolve; }`);
  const replies = []; let address = '';
  const deps = { abort: { current: null }, revision: { current: 0 }, alive: { current: true }, key: 'mock-only', useCallback: fn => fn,
    setResolving() {}, setError() {}, setAddress: value => { address = value; }, reverseAddress: () => new Promise(resolve => replies.push(resolve)) };
  const resolve = create(deps), first = resolve({ lat: 19, lon: 72 }), second = resolve({ lat: 20, lon: 73 });
  replies[1]('Newest address'); await second; replies[0]('Stale address'); await first; assert.equal(address, 'Newest address');
  const booking = await readFile(new URL('../../src/components/BookingModal.jsx', import.meta.url), 'utf8');
  assert.match(booking, /Choose Delivery Location on Map/); assert.match(booking, /isDelivery && addressCoords \? \{ deliveryCoordinates: addressCoords \}/);
  assert.match(booking, /setAddressCoords\(null\)/); assert.match(booking, /setAddressCoords\(\{ lat: props.lat, lon: props.lon \}\)/);
  assert.match(booking, /reviewedQuote\?\.deliveryCharge/); assert.match(booking, /geocode\/autocomplete/);
});

test('delivery pricing displays real rounded charges, explicit distance-free fallback, retry and missing-location states', async () => {
  const { default: Pricing } = await vite.ssrLoadModule('/src/components/DeliveryPricing.jsx');
  const { default: Pin } = await vite.ssrLoadModule('/src/components/LocationPinIcon.jsx');
  const props = { item: { locationCoordinates: { lat: 19, lon: 72 } }, coordinates: { lat: 19.1, lon: 72.1 }, form: { start: '2099-01-10', end: '2099-01-12', address: 'Reviewed address' }, loggedIn: true };
  const state = { calculate() {}, quote: { kind: 'calculated', distanceMeters: 12400, billableKm: 13, deliveryCharge: 445, totalPrice: 2845 } };
  const html = render(Pricing, { ...props, state });
  for (const text of ['12.40 km', '13 km', '₹120', '₹25', '₹445', '₹2,845', 'Recalculate Delivery']) assert.ok(html.includes(text), text);
  const exact = render(Pricing, { ...props, state: { ...state, quote: { ...state.quote, distanceMeters: 13000 } } });
  assert.doesNotMatch(exact, /Billable distance \(rounded up\)/);
  const estimated = render(Pricing, { ...props, state: { ...state, quote: { kind: 'estimated', deliveryCharge: 300, totalPrice: 2700 } } });
  assert.match(estimated, /₹300 is a temporary estimated delivery charge, subject to owner confirmation/);
  assert.doesNotMatch(estimated, /Road distance|Billable distance|NaN|undefined/);
  const retry = render(Pricing, { ...props, state: { error: 'Please retry', code: 'ROUTING_TEMPORARY', fallbackAllowed: true, calculate() {} } });
  assert.match(retry, /Retry Calculation/); assert.match(retry, /Confirm ₹300 Estimated Delivery/);
  const unavailable = render(Pricing, { ...props, item: {}, state: { calculate() {} } });
  assert.match(unavailable, /no confirmed map location/); assert.match(unavailable, /disabled=""/);
  assert.match(render(Pricing, { ...props, state: { loading: true, calculate() {} } }), /disabled=""/);
  const pin = render(Pin, {}); assert.match(pin, /aria-hidden="true"/);
  assert.equal((pin.match(/fill="#[a-f\d]{6}"/gi) || []).length >= 4, true);
  const booking = await readFile(new URL('../../src/components/BookingModal.jsx', import.meta.url), 'utf8');
  const hosting = await readFile(new URL('../../src/components/HostingForm.jsx', import.meta.url), 'utf8');
  assert.match(booking, /<span>Delivery Address<\/span>/); assert.match(booking, /placeholder="Enter your full address here"/);
  assert.match(booking, /<LocationPinIcon \/>Choose Delivery Location on Map/); assert.match(hosting, /<LocationPinIcon \/>Choose Location on Map/);
  const css = await readFile(new URL('../../src/components/DeliveryPricing.css', import.meta.url), 'utf8');
  for (const pattern of [/width:100%/, /min-height:48px/, /flex-wrap:wrap/, /@media\(max-width:480px\)/, /overflow-wrap:anywhere/]) assert.match(css, pattern);
});

test('delivery quote hook survives Strict Mode, prevents duplicate requests and invalidates expired or changed customer/location/date quotes', async () => {
  const source = await readFile(new URL('../../src/data/useDeliveryQuote.js', import.meta.url), 'utf8');
  // Execute the real hook with deterministic lifecycle slots, including Strict Mode's setup/cleanup/setup.
  const slots = [], effects = [], timers = new Map(), requests = [];
  let cursor = 0, jobs = [], timerId = 0;
  const deps = { useCallback: fn => fn, AbortController, JSON, Date,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useEffect(setup, values) { const index = cursor++, previous = effects[index]; if (!previous || values.some((value, i) => !Object.is(value, previous.values[i]))) {
      const entry = { setup, values, cleanup: previous?.cleanup }; effects[index] = entry; jobs.push(() => { entry.cleanup?.(); entry.cleanup = setup(); });
    } },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { return new Promise(resolve => requests.push({ url, options, resolve })); },
  };
  const hook = new Function('deps', `with (deps) { ${source.replace(/^import[^\n]*\n/, '').replace('export default ', '')}; return useDeliveryQuote; }`)(deps);
  let props = { user: { token: 'mock-only' }, item: { _id: 'vehicle', price: 1200, locationCoordinates: { lat: 19, lon: 72 } }, form: { start: '2099-01-10', end: '2099-01-12', address: 'Address' }, coordinates: { lat: 19.1, lon: 72.1 }, active: true };
  const renderHook = () => { cursor = 0; const result = hook(props); const pending = jobs; jobs = []; pending.forEach(run => run()); return result; };
  renderHook(); effects.filter(Boolean).forEach(effect => { effect.cleanup?.(); effect.cleanup = effect.setup(); });
  let state = renderHook();
  const quote = { quoteId: 'reviewed-reference', kind: 'calculated', deliveryCharge: 445, rentalAmount: 2400, totalPrice: 2845, expiresAt: new Date(Date.now() + 600000).toISOString() };
  const reply = (index, data = quote, ok = true) => requests[index].resolve({ ok, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data });
  const first = state.calculate(); await state.calculate(); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/bookings/delivery-quote');
  assert.equal(JSON.parse(requests[0].options.body).deliveryCharge, undefined);
  reply(0); await first; state = renderHook(); assert.equal(state.quote.quoteId, quote.quoteId);
  assert.equal(timers.size, 1); [...timers.values()][0](); state = renderHook(); assert.equal(state.quote, undefined); assert.match(state.error, /expired/);
  const next = state.calculate(); reply(1); await next; state = renderHook(); assert.ok(state.quote);
  props = { ...props, coordinates: { lat: 19.2, lon: 72.2 } }; state = renderHook(); assert.ok(!state.quote);
  const stale = state.calculate(); props = { ...props, user: { token: 'different-customer' } }; state = renderHook();
  assert.equal(requests[2].options.signal.aborted, true); reply(2); await stale; assert.ok(!renderHook().quote);
  state = renderHook(); const failure = state.calculate(); reply(3, { message: 'Retry the route', code: 'ROUTING_TEMPORARY', fallbackAllowed: true }, false); await failure;
  state = renderHook(); assert.equal(state.fallbackAllowed, true);
  const fallback = state.calculate(true); assert.equal(JSON.parse(requests[4].options.body).fallback, true);
  reply(4, { ...quote, kind: 'estimated', deliveryCharge: 300, totalPrice: 2700 }); await fallback; assert.equal(renderHook().quote.kind, 'estimated');
  props = { ...props, form: { ...props.form, end: '2099-01-13' } }; assert.ok(!renderHook().quote);
  effects.filter(Boolean).forEach(effect => effect.cleanup?.());
});

test('vehicle Owner/Admin details use saved pickup, distance and prices with safe route links; pickup UI requires no delivery address', async () => {
  const { OwnerRequestCard } = await vite.ssrLoadModule('/src/components/OwnerRequests.jsx');
  const { AdminRequestCard } = await vite.ssrLoadModule('/src/components/AdminRequests.jsx');
  const { default: BookingModal } = await vite.ssrLoadModule('/src/components/BookingModal.jsx');
  const base = { _id: 'phase3-ui-booking', requestType: 'vehicle', status: 'pending', startDate: '2099-01-10', endDate: '2099-01-12',
    contact: { name: 'Saved customer', phone: '9876543210' }, listing: { _id: '507f1f77bcf86cd799439011', title: 'Changed current title', location: 'Changed current address', price: 9000, type: 'vehicle' },
    vehicleSnapshot: { name: 'Saved booked vehicle', pickupAddress: 'Saved college pickup address', pickupCoordinates: { lat: 19.0636498, lon: 72.8456276 } } };
  for (const fulfilment of ['delivery', 'pickup']) {
    const row = { ...base, fulfilment, deliveryCharge: fulfilment === 'delivery' ? 445 : 0, totalPrice: fulfilment === 'delivery' ? 2845 : 2400,
      ...(fulfilment === 'delivery' ? { deliveryAddress: 'Saved delivery address', deliveryQuote: { kind: 'calculated', distanceMeters: 12400, rentalAmount: 2400,
        pickupAddress: base.vehicleSnapshot.pickupAddress, pickupCoordinates: base.vehicleSnapshot.pickupCoordinates, deliveryCoordinates: { lat: 19.24, lon: 73.12 } } } : {}) };
    for (const Component of [OwnerRequestCard, AdminRequestCard]) {
      const html = render(Component, { row, vehicle: true, decide() {}, onDecide() {} });
      for (const value of ['Saved booked vehicle', 'Saved customer', '9876543210', 'Saved college pickup address', 'Rental amount', 'Delivery charge', 'Total booking amount', '₹2,400']) assert.ok(html.includes(value), value);
      if (fulfilment === 'delivery') {
        for (const value of ['Saved delivery address', '12.40 km', '₹445', '₹2,845', 'View Route', 'travelmode=driving']) assert.ok(html.includes(value), value);
        const invalid = render(Component, { row: { ...row, deliveryQuote: { ...row.deliveryQuote, deliveryCoordinates: { lat: 91, lon: 72 } } }, vehicle: true });
        assert.doesNotMatch(invalid, /View Route/); assert.match(invalid, /Saved delivery address/);
        const estimate = render(Component, { row: { ...row, deliveryCharge: 300, totalPrice: 2700, deliveryQuote: { ...row.deliveryQuote, kind: 'estimated', distanceMeters: undefined } }, vehicle: true });
        assert.match(estimate, /subject to owner confirmation/); assert.doesNotMatch(estimate, /12\.40 km|NaN/);
      } else { assert.match(html, /₹0/); assert.match(html, /View Pickup Location/); assert.doesNotMatch(html, /Road distance|Delivery address|View Route/); }
    }
  }
  const pickup = render(BookingModal, { item: { ...base.listing, locationCoordinates: base.vehicleSnapshot.pickupCoordinates }, mode: 'vehicle', onClose() {} });
  assert.match(pickup, /Pickup Address:/); assert.match(pickup, /Changed current address/); assert.match(pickup, /View Pickup Location/);
  assert.doesNotMatch(pickup, /Enter your full address here|Choose Delivery Location on Map/);
});

test('autocomplete and map confirmation retain their coordinates, while manual delivery edits clear them', async () => {
  const source = await readFile(new URL('../../src/components/BookingModal.jsx', import.meta.url), 'utf8');
  const suggestion = source.match(/const selectSuggestion = feature => \{[\s\S]*?\n  \};/)?.[0];
  const manual = source.match(/const updateAddress = e => \{[\s\S]*?\n  \};/)?.[0]; assert.ok(suggestion); assert.ok(manual);
  let form = { address: 'Old address' }, coords;
  const deps = { setForm: fn => { form = fn(form); }, setAddressCoords: value => { coords = value; }, setSuggestions() {}, setShowSuggestions() {}, setError() {}, suggestTimer: { current: null }, suggestAbortRef: { current: null } };
  new Function('deps', `with(deps) { ${suggestion}; return selectSuggestion; }`)(deps)({ properties: { formatted: 'Autocomplete address', lat: 19.123456789, lon: 72.987654321 } });
  assert.deepEqual(coords, { lat: 19.123456789, lon: 72.987654321 }); assert.equal(form.address, 'Autocomplete address');
  new Function('deps', `with(deps) { ${manual}; return updateAddress; }`)(deps)({ target: { value: 'Hi' } });
  assert.equal(coords, null); assert.equal(form.address, 'Hi');
});

test('archived deletion uses bounded sequential batches, verifies outcomes and never includes IDs outside its confirmed set', async () => {
  const { hideArchivedAdminRequests } = await vite.ssrLoadModule('/src/components/AdminRequests.jsx');
  const ids = Array.from({ length: 451 }, (_, i) => String(i)), calls = [], progress = [];
  let active = 0, peak = 0;
  const result = await hideArchivedAdminRequests({ ids, type: 'property_visit', token: 'mock-only', isCurrent: () => true, onProgress: value => progress.push(value), send: async (url, options) => {
    active++; peak = Math.max(peak, active);
    assert.equal(url, '/api/admin/requests/hide-archived'); assert.equal(options.method, 'PUT');
    const body = JSON.parse(options.body); assert.equal(body.type, 'property_visit'); assert.ok(body.ids.length <= 200);
    calls.push(body.ids); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return new Response(JSON.stringify({ succeeded: body.ids.filter(id => id !== '201'), failed: body.ids.includes('201') ? [{ id: '201', message: 'Restored concurrently' }] : [] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(peak, 1); assert.deepEqual(calls.map(batch => batch.length), [200, 200, 51]); assert.deepEqual(calls.flat(), ids);
  assert.equal(result.succeeded.length, 450); assert.deepEqual(result.failed, [{ id: '201', message: 'Restored concurrently' }]); assert.deepEqual(progress, [200, 400, 451]);
  const invalid = await hideArchivedAdminRequests({ ids: ['a'], type: 'vehicle', token: 'mock-only', isCurrent: () => true, onProgress() {}, send: async () => new Response(JSON.stringify({ succeeded: ['outside-set'], failed: [] }), { headers: { 'Content-Type': 'application/json' } }) });
  assert.deepEqual(invalid.succeeded, []); assert.equal(invalid.failed.length, 1);
  let current = true, sent = 0;
  await hideArchivedAdminRequests({ ids, type: 'vehicle', token: 'mock-only', isCurrent: () => current, onProgress() {}, send: async (url, options) => {
    sent++; current = false;
    return new Response(JSON.stringify({ succeeded: JSON.parse(options.body).ids, failed: [] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(sent, 1);
});

test('Delete All prepares the server section snapshot independently of loaded filters and only submits after confirmation', async () => {
  const source = await readFile(new URL('../../src/components/AdminRequests.jsx', import.meta.url), 'utf8');
  const prepare = source.match(/const prepareDelete = async all => \{[\s\S]*?\n  \};/)?.[0];
  const apply = source.match(/const deleteArchived = async \(\) => \{[\s\S]*?\n  \};/)?.[0]; assert.ok(prepare); assert.ok(apply);
  const createPrepare = new Function('deps', `with (deps) { ${prepare}; return prepareDelete; }`);
  const createApply = new Function('deps', `with (deps) { ${apply}; return deleteArchived; }`);
  const ids = ['a'.repeat(24), 'b'.repeat(24)]; let calls = 0, sends = 0, finish;
  const deps = { actionLock: { current: false }, archived: true, loading: false, user: { role: 'admin', token: 'mock-only' }, scope: 'section', scopeRef: { current: 'section' }, type: 'vehicle', selectedIds: [ids[0]],
    setDeletePlan: value => { deps.deletePlan = value; }, deletePlan: null, setBusy() {}, setBulkError() {}, setNotice() {}, setProgress() {}, setSelection() {}, selectionKey: 'filters',
    setSnapshot() {}, load: async () => true, readResponse: async data => data,
    fetch: async url => { calls++; assert.equal(url, '/api/admin/requests/archived-set?type=vehicle'); return { type: 'vehicle', ids: [...ids], count: 2 }; },
    hideArchivedAdminRequests: async ({ ids: confirmed }) => { sends++; assert.deepEqual(confirmed, ids); return new Promise(resolve => { finish = resolve; }); } };
  const prepareDelete = createPrepare(deps), submit = createApply(deps);
  await submit(); assert.equal(sends, 0);
  await prepareDelete(true); assert.equal(calls, 1); assert.equal(sends, 0); assert.deepEqual(deps.deletePlan.ids, ids);
  // Cancel clears the plan, with no write; opening Selected uses only selected IDs.
  deps.setDeletePlan(null); await submit(); assert.equal(sends, 0);
  await prepareDelete(false); assert.deepEqual(deps.deletePlan.ids, [ids[0]]); assert.equal(calls, 1);
  await prepareDelete(true); const first = submit(); await submit(); assert.equal(sends, 1);
  finish({ succeeded: ids, failed: [] }); await first; assert.equal(deps.actionLock.current, false); assert.equal(deps.deletePlan, null);
});

test('category-specific amenities/features retain selections and custom chips, with no automatic selection', async () => {
  const { HostingFields } = await vite.ssrLoadModule('/src/components/HostingForm.jsx');
  for (const category of propertyCategories) {
    const form = hostingValues({ ...hostingFixture('property'), category, amenities: [] });
    const options = hostingChoiceOptions(form);
    assert.ok(options.length >= 8 && options.length <= 9);
    const html = render(HostingFields, { form, setForm() {} });
    assert.equal((html.match(/type="checkbox"/g) || []).length, options.length);
    assert.doesNotMatch(html, /checked=""/);
    for (const option of options) assert.ok(html.includes(option));
  }
  for (const kind of ['Car', 'Bike']) {
    const form = hostingValues({ ...hostingFixture('vehicle'), kind, category: kind, features: [] });
    const options = hostingChoiceOptions(form), html = render(HostingFields, { form, setForm() {} });
    assert.ok(options.includes('Bluetooth')); assert.ok(options.includes('USB charging'));
    if (kind === 'Bike') { assert.ok(options.includes('Helmet')); assert.ok(!options.includes('Air conditioning')); }
    else assert.ok(options.includes('Air conditioning'));
    assert.doesNotMatch(html, /checked=""/);
  }
  const values = addHostingChoice(['WiFi'], '  Rooftop   access  ');
  assert.deepEqual(values, ['WiFi', 'Rooftop access']);
  for (const bad of ['', '   ', 'wifi', ' ROOFTOP ACCESS ', 'x'.repeat(101)]) assert.throws(() => addHostingChoice(values, bad));
  const form = hostingValues({ ...hostingFixture('property'), category: 'Apartment', amenities: [...values, 'Lift'] });
  const changed = { ...form, category: 'Room' };
  assert.deepEqual(changed.amenities, form.amenities);
  const html = render(HostingFields, { form: changed, setForm() {} });
  assert.match(html, /Remove amenity Rooftop access/); assert.match(html, /Remove amenity Lift/);
  assert.deepEqual(validateHosting({ ...changed, amenities: [...values, ' WIFI '] }).amenities, values);
  assert.deepEqual(hostingValues({ ...hostingFixture(), amenities: ['Historical amenity'] }).amenities, ['Historical amenity']);
  assert.ok(hostingChoiceOptions({ type: 'vehicle', kind: 'Bike', category: 'Electric' }).includes('Charging cable'));
});

test('custom amenity/feature Add and Remove handlers update the existing arrays without losing other selections', async () => {
  const source = await readFile(new URL('../../src/components/HostingForm.jsx', import.meta.url), 'utf8');
  const component = source.slice(source.indexOf('export function HostingFields'), source.indexOf('export default function HostingForm')).replace('export function', 'function');
  const transformed = await transformWithOxc(component, 'hosting-fields.jsx', { jsx: { runtime: 'classic' } });
  const createFields = new Function('React', 'useState', 'hostingChoiceOptions', 'hostingChoiceKey', 'addHostingChoice', 'propertyCategories', 'vehicleCategories', 'furnishings', 'fuels', 'transmissions', 'hostingValues', 'useCallback', 'LocationPinIcon', transformed.code + '\nreturn HostingFields;');
  const choicesModule = await import('../../src/data/hosting.js');
  function walk(element, predicate) {
    if (!element || typeof element !== 'object') return null;
    if (predicate(element)) return element;
    return React.Children.toArray(element.props?.children).map(child => walk(child, predicate)).find(Boolean);
  }
  for (const type of ['property', 'vehicle']) {
    let form = hostingValues(hostingFixture(type));
    const key = type === 'property' ? 'amenities' : 'features';
    form[key] = [type === 'property' ? 'WiFi' : 'ABS'];
    let next, call = 0;
    const Fields = createFields(React, initial => [call++ === 0 ? '  Custom choice  ' : initial, () => {}], hostingChoiceOptions, hostingChoiceKey, addHostingChoice,
      choicesModule.propertyCategories, choicesModule.vehicleCategories, choicesModule.furnishings, choicesModule.fuels, choicesModule.transmissions, hostingValues, fn => fn, () => null);
    let element = Fields({ form, setForm: value => { next = value; } });
    walk(element, node => node.type === 'button' && node.props.children === 'Add').props.onClick();
    assert.deepEqual(next[key], [...form[key], 'Custom choice']);
    form = next; call = 0;
    element = Fields({ form, setForm: value => { next = value; } });
    walk(element, node => node.type === 'button' && node.props['aria-label']?.endsWith('Custom choice')).props.onClick();
    assert.deepEqual(next[key], [type === 'property' ? 'WiFi' : 'ABS']);
  }
});

test('vehicle booking success confirms Pending submission and offers only Done', async () => {
  const source = await readFile(new URL('../../src/components/BookingModal.jsx', import.meta.url), 'utf8');
  const success = source.match(/done \? \(\s*([\s\S]*?)\n\s*\) : \(/)?.[1];
  assert.ok(success);
  const transformed = await transformWithOxc(success, 'booking-success.jsx', { jsx: { runtime: 'classic' } });
  const successView = new Function('React', 'isVehicle', 'onClose', 'openWhatsapp', 'error = ""', 'return ' + transformed.code);
  let closed = 0, shared = 0;
  const element = successView(React, true, () => { closed++; }, () => { shared++; });
  const html = renderToStaticMarkup(element);
  assert.match(html, /class="success-mark">✓/);
  assert.match(html, /<h2>Booking request submitted!<\/h2>/);
  assert.ok(html.includes('Your vehicle booking request has been successfully sent to the owner and is currently Pending. Once the owner accepts your request, you can contact them on WhatsApp to discuss pickup, delivery, and other booking details.'));
  assert.match(html, /class="btn btn-primary full">Done<\/button>/);
  assert.doesNotMatch(html, /Contact Owner on WhatsApp/);
  assert.equal(closed, 0); assert.equal(shared, 0);
  const buttons = element.props.children[1].props.children.filter(child => child.type === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.children, 'Done');
  buttons[0].props.onClick(); assert.equal(closed, 1); assert.equal(shared, 0);
  const propertyHtml = renderToStaticMarkup(successView(React, false, () => {}, () => {}));
  assert.match(propertyHtml, /WhatsApp is ready/); assert.doesNotMatch(propertyHtml, /Booking request submitted!/);
});

test('vehicle cards/details show booking-derived status, preserve Book Now and show only the partial-booking image banner', async () => {
  const { VehicleCard, VehicleBookingBanner } = await vite.ssrLoadModule('/src/components/ListingCards.jsx');
  const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
  const data = await vite.ssrLoadModule('/src/data/listings.js');
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem() { return null; } };
  try {
    for (const [state, available, label] of [['available', true, 'AVAILABLE'], ['partially-booked', true, 'PARTIALLY BOOKED'], ['partially-booked', false, 'CURRENTLY UNAVAILABLE']]) {
      const item = { ...hostingFixture('vehicle'), id: 'vehicle-status-ui', _id: '507f1f77bcf86cd799439011', status: 'available', available,
        vehicleBookingStatus: state, gallery: ['https://example.test/vehicle.jpg'] };
      const card = render(VehicleCard, { item, onSave() {} });
      assert.ok(card.includes(label));
      assert.match(card, available ? state === 'available' ? /vehicle-status--available/ : /vehicle-status--partial/ : /vehicle-status--unavailable/);
      data.vehicles.push(item);
      try {
        const details = render(App, {}, '/vehicles/' + item.id);
        assert.ok(details.includes(label));
        if (available) { assert.match(details, /Book now/); assert.doesNotMatch(details, /disabled=""[^>]*>[^<]*Currently Unavailable/); }
        else { assert.match(details, /disabled=""[^>]*>[^<]*Currently Unavailable/); assert.doesNotMatch(details, /Book now/); }
        assert.equal(details.includes('vehicle-booking-banner'), available && state === 'partially-booked');
      } finally { data.vehicles.pop(); }
      const banner = render(VehicleBookingBanner, { item, onCheckDates() {} });
      if (available && state === 'partially-booked') {
        assert.match(banner, /This vehicle is booked for certain dates/);
        assert.match(banner, /You can still reserve it for other available dates!/);
        assert.match(banner, /Check Available Dates/);
        let opened = false;
        const element = VehicleBookingBanner({ item, onCheckDates: () => { opened = true; } });
        element.props.children[1].props.onClick();
        assert.equal(opened, true);
      } else assert.equal(banner, '');
    }
    const loading = render(VehicleCard, { item: { ...hostingFixture('vehicle'), _id: 'database-id', status: 'available' }, onSave() {} });
    assert.match(loading, /Checking availability/); assert.doesNotMatch(loading, />AVAILABLE</);
    const source = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
    assert.match(source, /VehicleBookingBanner item=\{item\} onCheckDates=\{\(\) => setBooking\(true\)\}/);
    assert.equal((source.match(/<BookingModal /g) || []).length, 1);
    const css = await readFile(new URL('../../src/index.css', import.meta.url), 'utf8');
    assert.match(css, /@media\(max-width:700px\)\{\.vehicle-detail-image/);
    assert.match(css, /@media\(max-width:560px\)\{\.vehicle-detail-image/);
  } finally { globalThis.localStorage = previousStorage; }
});

test('compact vehicle calendar disables booked/past days and crossing ranges, with identical owner/customer booking colors', async () => {
  const { VehicleCalendarDays, default: VehicleCalendar } = await vite.ssrLoadModule('/src/components/VehicleCalendar.jsx');
  const props = { month: '2095-01', today: '2095-01-05', data: { from: '2095-01-01', to: '2095-01-31', available: true,
    bookedRanges: [{ startDate: '2095-01-10T00:00:00Z', endDate: '2095-01-12T00:00:00Z' }] } };
  const customer = render(VehicleCalendarDays, { ...props, onSelect() {} });
  const owner = render(VehicleCalendarDays, props);
  for (const html of [customer, owner]) {
    assert.match(html, /class="vehicle-calendar-day is-booked"[^>]*aria-label="2095-01-10: booked"[^>]*disabled/);
    assert.match(html, /class="vehicle-calendar-day is-booked"[^>]*aria-label="2095-01-12: booked"[^>]*disabled/);
    assert.match(html, /class="vehicle-calendar-day is-past"[^>]*aria-label="2095-01-04: past"[^>]*disabled/);
    assert.match(html, /class="vehicle-calendar-day is-available"[^>]*aria-label="2095-01-13: available"/);
  }
  assert.doesNotMatch(customer, /aria-label="2095-01-13: available"[^>]*disabled/);
  const selectingEnd = render(VehicleCalendarDays, { ...props, field: 'end', startDate: '2095-01-06', onSelect() {} });
  assert.match(selectingEnd, /aria-label="2095-01-13: Range crosses a confirmed booking"[^>]*disabled/);
  assert.match(render(VehicleCalendarDays, { ...props, startDate: '2095-01-06', endDate: '2095-01-08', onSelect() {} }), /is-selected/);
  const loading = render(VehicleCalendarDays, { ...props, data: null, onSelect() {} });
  assert.equal((loading.match(/disabled=""/g) || []).length, 31);
  const wrapper = render(VehicleCalendar, { item: { _id: '507f1f77bcf86cd799439011' }, onChange() {} });
  for (const label of ['Previous month', 'Next month', 'Pickup date', 'Return date', 'Booked', 'Selected']) assert.ok(wrapper.includes(label));
  const css = await readFile(new URL('../../src/components/VehicleCalendar.css', import.meta.url), 'utf8');
  assert.match(css, /max-width:350px/); assert.match(css, /grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:380px\)/);
  const modal = await readFile(new URL('../../src/components/BookingModal.jsx', import.meta.url), 'utf8');
  assert.match(modal, /VehicleCalendar item=\{item\} startDate=\{form.start\} endDate=\{form.end\} onChange=/);
  assert.doesNotMatch(modal, /name="end" type="date"/);
});

test('saved property interest availability renders consistently on public, owner, admin and detail status displays', async () => {
  const { PropertyCard } = await vite.ssrLoadModule('/src/components/ListingCards.jsx');
  const { default: OwnerProductCard } = await vite.ssrLoadModule('/src/components/OwnerProductCard.jsx');
  const { default: ListingControls } = await vite.ssrLoadModule('/src/components/ListingControls.jsx');
  const { detailHeader } = await import('../../src/data/detailHeader.js');
  const item = { _id: '507f1f77bcf86cd799439011', title: 'Interest fixture', type: 'property', location: 'Mumbai',
    price: 1000, status: 'available', available: false, availability: 'Unavailable', catalogContext: 'staging' };
  assert.match(render(PropertyCard, { item, saved: false, onSave() {} }), /class="status">Unavailable/);
  assert.match(render(OwnerProductCard, { item, canManage: true, onChanged() {} }), /owner-availability is-unavailable">Unavailable/);
  assert.match(render(ListingControls, { item, onChanged() {} }), /<small>Unavailable<\/small>/);
  assert.equal(detailHeader(item, true), 'property · Unavailable');
});

test('compact vehicle and property cards retain all request details and cancellation eligibility', async () => {
  const { RequestHistoryCard } = await vite.ssrLoadModule('/src/components/CustomerRequests.jsx');
  for (const type of ['vehicle', 'property']) {
    const row = { _id: 'request-ui', listing: { _id: '507f1f77bcf86cd799439011', type, title: 'Compact ' + type, image: '/listing.jpg' },
      requestType: type === 'property' ? 'property_visit' : 'vehicle', startDate: '2091-03-01T00:00:00Z', endDate: '2091-03-03T00:00:00Z',
      status: 'pending', totalPrice: 2200, fulfilment: 'delivery', deliveryAddress: 'Complete delivery address', deliveryCharge: 300, createdAt: '2026-10-21T00:00:00Z' };
    const html = render(RequestHistoryCard, { row, onCancel() {} });
    for (const text of ['request-card-thumbnail', 'Compact ' + type, 'Pending', '2091-03-01', 'Created', 'View listing', 'Cancel request']) assert.ok(html.includes(text), text);
    if (type === 'vehicle') for (const text of ['2091-03-03', '₹2,200', 'Complete delivery address', '₹300']) assert.ok(html.includes(text), text);
    else { assert.match(html, /Visit date/); assert.match(html, /Awaiting decision/); }
    for (const status of ['rejected', 'cancelled', 'completed']) assert.doesNotMatch(render(RequestHistoryCard, { row: { ...row, status }, onCancel() {} }), /Cancel request/);
    assert.doesNotMatch(render(RequestHistoryCard, { row: { ...row, status: 'confirmed', startDate: '2020-01-01', endDate: '2020-01-02' }, onCancel() {} }), /Cancel request/);
  }
  const css = await readFile(new URL('../../src/components/CustomerRequests.css', import.meta.url), 'utf8');
  assert.match(css, /\.request-card-grid\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:1050px\)\{\.request-card-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(css, /@media\(max-width:640px\)\{\.request-card-grid\{grid-template-columns:1fr\}/);
  assert.match(css, /\.request-status-filter\{[^}]*appearance:none/);
  const source = await readFile(new URL('../../src/components/CustomerRequests.jsx', import.meta.url), 'utf8');
  assert.match(source, /<div className="request-card-grid">\{shown.map/);
  assert.match(source, /className="request-status-filter"/);
});

test('admin products has no request inbox; owner retains Accept/Reject, and footer holds linked attribution', async () => {
  const admin = await readFile(new URL('../../src/components/AdminPanel.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(admin, /OwnerRequests|Customer Requests/);
  assert.match(admin, /<ListingControls item=\{p\} onChanged=\{loadAdminData\}/);
  assert.match(admin, /handleDeleteProduct\(p\._id/);
  const owner = await readFile(new URL('../../src/components/UserDashboard.jsx', import.meta.url), 'utf8');
  assert.match(owner, /canManage && <OwnerRequests/);
  const inbox = await readFile(new URL('../../src/components/OwnerRequests.jsx', import.meta.url), 'utf8');
  assert.match(inbox, /decide\(row, 'confirm'\)/); assert.match(inbox, /decide\(row, 'reject'\)/);
  const { Footer } = await vite.ssrLoadModule('/src/components/Layout.jsx');
  const credit = { author: 'Image Author', sourcePage: 'https://example.test/photo', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', attribution: 'Required attribution' };
  const html = render(Footer, { mediaCredits: [credit] });
  for (const text of [credit.author, credit.sourcePage, credit.licenseUrl, 'site-image-credits']) assert.ok(html.includes(text));
  assert.doesNotMatch(html, /<details|<summary/);
  assert.doesNotMatch(render(Footer), /site-image-credits/);
  assert.doesNotMatch(render(Footer, { mediaCredits: null }), /site-image-credits/);
});
after(async () => { await vite?.close(); });
const render = (Component, props = {}, path = '/dashboard', user = { role: 'user', name: 'UI fixture', token: 'ui-only' }) => renderToStaticMarkup(
  React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(AuthContext.Provider,
    { value: { user, account: user, accountStatus: 'ready', logout() {}, login() {} } }, React.createElement(Component, props))));

test('customer dashboard has application CTA and history without any owner-only sections', async () => {
  const { default: Dashboard } = await vite.ssrLoadModule('/src/components/UserDashboard.jsx');
  const html = render(Dashboard);
  for (const label of ['User Dashboard', 'My Vehicle Bookings', 'My Property Visits', 'Pending requests', 'Upcoming / active', 'Past / completed', 'Rejected / cancelled', 'Want to List Your Property or Vehicle?', 'Become an Owner']) assert.ok(html.includes(label));
  assert.match(html, /Saved Listings/);
  assert.doesNotMatch(html, /Host a New Rental|My Uploaded Products|Customer Requests|Verified Owner/);
  assert.match(html, /href="\/become-owner"/);
});

// Run the existing component and its fetch effects with deterministic hook state;
// cards still render through React and the existing router/context.
async function listingComponentHarness(source, name, props, dependencies) {
  const { code } = await transformWithOxc(source, 'listing-regression.jsx', { jsx: { runtime: 'classic' } });
  const slots = []; let cursor = 0, effects = [];
  const deps = { React, useContext: () => ({ user: { token: 'saved-test-token' } }),
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useEffect(fn) { effects.push(fn); }, useMemo: fn => fn(), ...dependencies };
  const Component = new Function('deps', `with(deps) { ${code}; return ${name}; }`)(deps);
  const tree = () => { cursor = 0; effects = []; return Component(props); };
  const html = () => render(() => tree());
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
  html(); const cleanups = effects.map(effect => effect()); await flush();
  return { html, tree, flush, close: () => cleanups.forEach(clean => clean?.()) };
}

test('saved dashboard cards render both types, correct detail links and unavailable state; unsave events and refresh reload the existing API', async () => {
  const cards = await vite.ssrLoadModule('/src/components/ListingCards.jsx');
  const source = (await readFile(new URL('../../src/components/SavedListings.jsx', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace('export default ', '');
  let rows = [{ _id: 'a'.repeat(24), type: 'property', title: 'Saved property fixture', price: 1200, available: false, status: 'available', availability: 'Unavailable', catalogContext: 'staging' },
    { _id: 'b'.repeat(24), type: 'vehicle', name: 'Saved vehicle fixture', price: 500, available: false }];
  const events = new Map(), saved = new Set(rows.map(row => row._id)); let calls = 0;
  const deps = { AuthContext, ...cards, window: { addEventListener: (event, fn) => events.set(event, fn), removeEventListener: event => events.delete(event) },
    useSaved: () => [saved, id => { saved.delete(id); rows = rows.filter(row => row._id !== id); events.get('rentsphere-saved-changed')(); }],
    fetch: async (url, options) => { calls++; assert.equal(url, '/api/saved'); assert.equal(options.headers.Authorization, 'Bearer saved-test-token'); return new Response(JSON.stringify([...rows, null, {}])); } };
  const view = await listingComponentHarness(source, 'SavedListings', {}, deps);
  try {
    const html = view.html();
    assert.match(html, /Saved property fixture/); assert.match(html, /Saved vehicle fixture/);
    assert.ok(html.includes('/properties/' + 'a'.repeat(24))); assert.ok(html.includes('/vehicles/' + 'b'.repeat(24)));
    assert.match(html, /Unavailable/); assert.match(html, /CURRENTLY UNAVAILABLE/);
    const find = element => element?.type === cards.PropertyCard ? element : React.Children.toArray(element?.props?.children).map(find).find(Boolean);
    const card = find(view.tree()); card.props.onSave(card.props.item._id); await view.flush();
    assert.doesNotMatch(view.html(), /Saved property fixture/); assert.match(view.html(), /Saved vehicle fixture/);
    assert.equal(calls, 2);
  } finally { view.close(); }
  const refreshed = await listingComponentHarness(source, 'SavedListings', {}, deps);
  try { assert.match(refreshed.html(), /Saved vehicle fixture/); assert.doesNotMatch(refreshed.html(), /Saved property fixture/); }
  finally { refreshed.close(); }
});

test('property and vehicle browsing distinguish successful populated/empty responses from API, network and malformed-response errors', async () => {
  const app = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function Listings('), app.indexOf('function Detail('));
  const data = await vite.ssrLoadModule('/src/data/listings.js'), locations = await vite.ssrLoadModule('/src/data/locations.js');
  const catalog = await vite.ssrLoadModule('/src/data/catalog.js'), cards = await vite.ssrLoadModule('/src/components/ListingCards.jsx');
  for (const type of ['property', 'vehicle']) for (const failure of ['api', 'network', 'html', 'shape']) {
    const events = new Map(); let mode = failure;
    const row = { _id: 'c'.repeat(24), type, title: 'Loaded listing fixture', name: 'Loaded listing fixture', location: 'Mumbai', price: 500, status: 'available', available: true, catalogContext: 'staging' };
    const deps = { ...data, ...locations, ...catalog, ...cards, Page: ({ children }) => React.createElement('main', null, children), applyStoredPropertyStatus: value => value,
      useSaved: () => [new Set(), () => {}], useLocation: () => ({ key: 'test', search: '' }),
      window: { location: { search: '' }, addEventListener: (event, fn) => events.set(event, fn), removeEventListener: event => events.delete(event), setInterval: () => 1, clearInterval() {} },
      fetch: async url => { assert.equal(url, '/api/listings?type=' + type); if (mode === 'network') throw new Error('Network unavailable'); return mode === 'api' ? new Response('{}', { status: 503 }) : mode === 'html' ? new Response('<!DOCTYPE html>') : new Response(JSON.stringify(mode === 'shape' ? {} : mode === 'empty' ? [] : [row])); } };
    const view = await listingComponentHarness(source, 'Listings', { type }, deps);
    try {
      assert.match(view.html(), /Unable to load listings\. Please try again\./); assert.doesNotMatch(view.html(), /No close matches yet|No matching|Updated for your search/);
      if (type === 'vehicle') {
        mode = 'populated'; events.get('focus')(); await view.flush();
        assert.match(view.html(), /Loaded listing fixture/); assert.doesNotMatch(view.html(), /Unable to load listings/);
        mode = 'empty'; events.get('focus')(); await view.flush();
        assert.match(view.html(), /No close matches yet/); assert.doesNotMatch(view.html(), /Loaded listing fixture|Unable to load listings/);
      }
    } finally { view.close(); }
    // A fresh successful empty request must also remain empty for properties.
    mode = 'empty'; const empty = await listingComponentHarness(source, 'Listings', { type }, deps);
    try { assert.match(empty.html(), /No close matches yet/); assert.doesNotMatch(empty.html(), /Unable to load listings/); }
    finally { empty.close(); }
  }
});

test('verified dashboards and navbar distinguish customers, approved owners and admins, including pending/rejected applications', async () => {
  const { default: Dashboard } = await vite.ssrLoadModule('/src/components/UserDashboard.jsx');
  const { Navbar } = await vite.ssrLoadModule('/src/components/Layout.jsx');
  const withContext = (Component, context, props = {}) => renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: ['/dashboard'] }, React.createElement(AuthContext.Provider, { value: { logout() {}, refreshAccount() {}, ...context } }, React.createElement(Component, props))));
  for (const [role, status, label, href] of [['user', 'not_started', 'User Dashboard', '/dashboard'], ['owner', 'pending', 'User Dashboard', '/dashboard'], ['owner', 'rejected', 'User Dashboard', '/dashboard'], ['owner', 'approved', 'Owner Dashboard', '/owner-dashboard'], ['admin', 'approved', 'Admin Dashboard', '/admin']]) {
    const user = { _id: 'ui-account', name: 'Dashboard fixture', role, token: 'ui-only', ownerProfile: { listingIntent: 'both', status, reviewNote: status === 'rejected' ? 'Please clarify your application.' : '' } };
    const context = { user, account: user, accountStatus: 'ready' };
    const nav = withContext(Navbar, context);
    assert.ok(nav.includes(`href="${href}"`)); assert.ok(nav.includes(label));
    assert.equal((nav.match(/>[^<]*Dashboard<\/a>/g) || []).length, 1);
    assert.doesNotMatch(nav, /My Listings|Owner Application/);
    if (status === 'approved') {
      for (const accountStatus of ['loading', 'error']) {
        const retryNav = withContext(Navbar, { ...context, accountStatus });
        assert.ok(retryNav.includes(label)); assert.ok(retryNav.includes(`href="${href}"`));
      }
    }
    const html = withContext(Dashboard, context);
    if (role === 'admin') { assert.equal(dashboardKind(user), 'admin'); assert.doesNotMatch(html, /Host a New Rental/); continue; }
    assert.ok(html.includes(label)); assert.ok(html.includes('My Bookings &amp; Visits'));
    if (status === 'approved') {
      const sections = ['My Uploaded Products', 'Customer Requests', 'Host a New Rental', 'My Bookings &amp; Visits'];
      assert.ok(sections.every(x => html.includes(x)));
      for (let i = 1; i < sections.length; i++) assert.ok(html.indexOf(sections[i - 1]) < html.indexOf(sections[i]));
      assert.match(html, /Verified Owner/); assert.match(html, /href="#hosting-form"/); assert.match(html, /id="hosting-form"/);
      for (const field of ['Home size', 'BHK/layout', 'Furnishing', 'Owner contact number']) assert.ok(html.includes(field));
    } else {
      assert.doesNotMatch(html, /Host a New Rental|My Uploaded Products|Customer Requests|Verified Owner/);
      if (status === 'pending') { assert.match(html, /Application Under Review/); assert.doesNotMatch(html, /Become an Owner →|Reapply/); }
      if (status === 'rejected') { assert.match(html, /Application Rejected/); assert.match(html, /Please clarify your application/); assert.match(html, /Reapply/); }
    }
    if (status !== 'approved') assert.equal(withContext(Dashboard, context, { ownerOnly: true }), '');
  }
  const cachedOwner = { name: 'Cached owner', role: 'owner', token: 'ui-only', ownerProfile: { status: 'approved' } };
  for (const accountStatus of ['loading', 'error']) {
    const html = withContext(Dashboard, { user: cachedOwner, account: null, accountStatus });
    assert.doesNotMatch(html, /Host a New Rental|My Uploaded Products|Verified Owner/);
    assert.match(html, accountStatus === 'loading' ? /Verifying your account/ : /Retry account check/);
  }
  assert.equal(withContext(Dashboard, { user: null, account: null, accountStatus: 'anonymous' }), '');
  const source = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /path="\/owner-dashboard" element=\{<Page><UserDashboard ownerOnly/);
});

test('cancelled cards alone offer subtle history removal and the custom dialog retains accessible confirmation/error text', async () => {
  const { RequestHistoryCard } = await vite.ssrLoadModule('/src/components/CustomerRequests.jsx');
  const { default: Dialog } = await vite.ssrLoadModule('/src/components/HistoryConfirmation.jsx');
  for (const type of ['vehicle', 'property']) {
    const row = { _id: 'cancelled-ui', status: 'cancelled', requestType: type === 'property' ? 'property_visit' : 'vehicle', startDate: '2092-01-01', endDate: '2092-01-03', listing: { _id: 'listing-ui', type, title: 'Cancelled fixture' } };
    const html = render(RequestHistoryCard, { row, onCancel() {}, onRemove() {} });
    assert.match(html, /Remove request from history/); assert.match(html, /class="history-remove"/); assert.doesNotMatch(html, /Cancel request<\/button>/);
    for (const status of ['pending', 'confirmed', 'rejected']) assert.match(render(RequestHistoryCard, { row: { ...row, status }, onCancel() {}, onRemove() {} }), /Remove request from history/);
  }
  const html = render(Dialog, { removing: true, busy: false, error: 'Try again', onClose() {}, onConfirm() {} });
  for (const text of ['Remove from history?', 'This request will be hidden from your dashboard. It will remain available to the owner and administrator. Its status and reserved dates will not change.', '>Cancel<', '>Remove<', 'role="dialog"', 'aria-modal="true"', 'aria-labelledby=', 'aria-describedby=', 'Try again']) assert.ok(html.includes(text), text);
  const source = await readFile(new URL('../../src/components/HistoryConfirmation.jsx', import.meta.url), 'utf8');
  assert.match(source, /event.key === 'Escape'/); assert.match(source, /event.key !== 'Tab'/); assert.match(source, /trigger.focus\(\)/);
});

test('history removal changes visible state only after a confirmed successful server response', async () => {
  let visible = ['request-id'];
  const remove = response => removeHistoryRequest({ id: 'request-id', token: 'mock-only', onRemoved: id => { visible = visible.filter(x => x !== id); }, fetcher: async (url, options) => { assert.equal(url, '/api/bookings/request-id/hide'); assert.equal(options.method, 'PUT'); return response; } });
  await assert.rejects(remove({ ok: false, json: async () => ({ message: 'Temporary failure' }) }), /Temporary failure/);
  assert.deepEqual(visible, ['request-id']);
  await assert.rejects(remove({ ok: true, json: async () => ({ _id: 'request-id', hiddenFromCustomer: false }) }), /Unable to confirm/);
  assert.deepEqual(visible, ['request-id']);
  await assert.rejects(remove({ ok: true, json: async () => { throw new Error('Malformed fixture response'); } }), /Unable to remove request/);
  assert.deepEqual(visible, ['request-id']);
  await remove({ ok: true, json: async () => ({ _id: 'request-id', hiddenFromCustomer: true }) });
  assert.deepEqual(visible, []);
});

test('hosting fields are type-specific, prefilled and validated; approved banner targets the stable form anchor', async () => {
  const { HostingFields, default: Form } = await vite.ssrLoadModule('/src/components/HostingForm.jsx');
  for (const type of ['property', 'vehicle']) {
    const form = hostingValues(hostingFixture(type));
    const html = render(HostingFields, { form, setForm() {}, editing: true });
    for (const text of ['Complete location/address', 'Owner contact number', 'Detailed description', form.title, form.location, form.phone]) assert.ok(html.includes(text), text);
    assert.match(html, /type="checkbox"/); assert.match(html, /type="number"/); assert.match(html, /<select disabled/);
    if (type === 'property') {
      for (const text of ['Property title', 'Property category', 'Monthly rent', 'Home size', 'BHK/layout', 'Furnishing', 'Floor', 'Amenities']) assert.ok(html.includes(text), text);
      assert.doesNotMatch(html, /Fuel type|Transmission|Seating capacity|Vehicle features/);
    } else {
      for (const text of ['Vehicle name', 'Vehicle type', 'Vehicle category', 'Daily rental price', 'Fuel type', 'Transmission', 'Seating capacity', 'Vehicle features']) assert.ok(html.includes(text), text);
      assert.doesNotMatch(html, /Home size|BHK\/layout|Furnishing|Monthly rent/);
    }
    assert.equal(validateHosting(form).price, form.price);
    assert.throws(() => validateHosting({ ...form, phone: '123' }), /Indian mobile/);
    const edit = render(Form, { item: { ...hostingFixture(type), _id: 'edit-ui', gallery: ['https://example.test/other.jpg'] }, token: 'ui-only' }, '/owner-dashboard', { role: 'owner', token: 'ui-only', ownerProfile: { status: 'approved', listingIntent: 'both' } });
    assert.match(edit, /Save changes/); assert.match(edit, /multiple/); assert.match(edit, /Existing image 1/); assert.match(edit, /Existing image 2/);
  }
  const { OwnerStatusNotice } = await vite.ssrLoadModule('/src/components/UserDashboard.jsx');
  const approved = render(OwnerStatusNotice, { status: 'approved', approved: true });
  assert.match(approved, /Verified Owner/); assert.match(approved, /href="#hosting-form"/); assert.match(approved, /Want to add a product/);
  for (const status of ['pending', 'rejected', 'in_progress']) assert.doesNotMatch(render(OwnerStatusNotice, { status, approved: false }), /Want to add a product/);
  assert.doesNotMatch(render(OwnerStatusNotice, { status: 'approved', approved: false }), /Want to add a product/);
  const source = await readFile(new URL('../../src/components/UserDashboard.jsx', import.meta.url), 'utf8');
  assert.match(source, /scrollIntoView\(\{ behavior: 'smooth'/);
});

test('new property and vehicle details show submitted specifications, description, features and honest unrated state', async () => {
  const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
  const data = await vite.ssrLoadModule('/src/data/listings.js');
  const { PropertyCard, VehicleCard } = await vite.ssrLoadModule('/src/components/ListingCards.jsx');
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem() { return null; } };
  try {
    for (const type of ['property', 'vehicle']) {
      const rows = type === 'property' ? data.properties : data.vehicles;
      const item = { ...hostingFixture(type), id: 'new-owner-ui-' + type, name: 'Owner test ' + type, rating: 0, status: 'available', gallery: ['https://example.test/one.jpg', 'https://example.test/two.jpg'], ...(type === 'property' ? { area: 777, bhk: 0, floor: 'Ground floor', amenities: ['Gym', 'Lift', 'Rooftop access'] } : { kind: 'Bike', category: 'Sport bike', seats: 2, features: ['Helmet', 'ABS', 'Rear camera'] }) };
      rows.push(item);
      try {
        const html = render(App, {}, `/${type === 'property' ? 'properties' : 'vehicles'}/${item.id}`);
        const glance = html.split('<h2>At a glance</h2>')[1].split('</article>')[0];
        assert.match(glance, /Not yet rated/); assert.doesNotMatch(glance, /★ 4\.5/);
        for (const text of type === 'property' ? ['777 sq.ft', 'Studio', 'Ground floor', item.furnishing] : [item.fuel, item.transmission, '>2<', item.category]) assert.ok(glance.includes(text), text);
        assert.ok(html.includes(item.description));
        const features = html.split('<div class="amenities">')[1].split('</div>')[0];
        for (const text of type === 'property' ? item.amenities : item.features) assert.ok(features.includes(text));
        assert.doesNotMatch(features, /Verified listing|24\/7 support/);
        for (const image of item.gallery) assert.ok(html.includes(image));
        const card = render(type === 'property' ? PropertyCard : VehicleCard, { item, onSave() {} });
        assert.match(card, /Not yet rated/); assert.doesNotMatch(card, /★ 4\.5/);
      } finally { rows.pop(); }
    }
  } finally { globalThis.localStorage = previousStorage; }
});

test('owner controls offer editing while admin controls do not; reset forms reuse auth styling and login has a reset link', async () => {
  const { default: Controls } = await vite.ssrLoadModule('/src/components/ListingControls.jsx');
  const item = { _id: '507f1f77bcf86cd799439011', title: 'Fixture', type: 'vehicle', status: 'available', price: 1000, location: 'Mumbai' };
  assert.match(render(Controls, { item, allowEdit: true, onChanged() {} }, '/owner-dashboard', { role: 'owner', token: 'ui-only', ownerProfile: { status: 'approved', listingIntent: 'both' } }), /Edit listing/);
  const admin = render(Controls, { item, onChanged() {} }, '/admin', { role: 'admin', token: 'ui-only' });
  assert.doesNotMatch(admin, /Edit listing/); assert.match(admin, /Make unavailable/); assert.match(admin, /Booking calendar/);
  const { default: Reset } = await vite.ssrLoadModule('/src/components/PasswordResetForm.jsx');
  const forgot = render(Reset, {}, '/forgot-password');
  assert.match(forgot, /class="auth-page"/); assert.match(forgot, /Send reset email/);
  const reset = render(Reset, { reset: true }, '/reset-password#' + 'a'.repeat(64));
  assert.match(reset, /Choose a new password/); assert.match(reset, /Confirm password/);
  const { default: Login } = await vite.ssrLoadModule('/src/components/AuthForm.jsx');
  assert.match(render(Login, {}, '/login'), /href="\/forgot-password"/);
});

test('polished owner product cards retain every applicable action and authoritative availability without altering customer styling', async () => {
  const { default: Product } = await vite.ssrLoadModule('/src/components/OwnerProductCard.jsx');
  for (const type of ['property', 'vehicle']) for (const available of [true, false]) {
    const item = { ...hostingFixture(type), _id: 'owner-product-ui', status: 'available', available };
    const html = render(Product, { item, canManage: true, onChanged() {}, onDelete() {} }, '/owner-dashboard', { role: 'owner', token: 'ui-only', ownerProfile: { status: 'approved', listingIntent: 'both' } });
    for (const text of ['owner-rental-image', item.title, item.location, item.category, 'View Listing', 'Edit listing', 'Delete', available ? 'Make unavailable' : 'Make available', available ? '>Available<' : '>Unavailable<']) assert.ok(html.includes(text), text);
    assert.ok(html.includes(type === 'property' ? '/month' : '/day') || html.includes(type === 'property' ? '/ month' : '/ day'));
    assert.equal(html.includes('Booking calendar'), type === 'vehicle');
    assert.doesNotMatch(render(Product, { item, canManage: false }), /Edit listing|Make unavailable|Make available|>Delete</);
  }
  const css = await readFile(new URL('../../src/components/OwnerDashboard.css', import.meta.url), 'utf8');
  assert.match(css, /\.owner-dashboard \.owner-rental-image\{[^}]*height:180px/);
  assert.match(css, /\.owner-dashboard \.owner-request-grid\{[^}]*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:720px\).*\.owner-dashboard \.owner-request-grid\{grid-template-columns:1fr\}/);
  assert.doesNotMatch(css, /\.dashboard-request-card|\.request-card-grid|\.site-header|\.footer|\.owner-promotion/);
});

test('owner property visit cards display the saved address and actual submission date/time in IST with neutral legacy fallbacks', async () => {
  const { OwnerRequestCard } = await vite.ssrLoadModule('/src/components/OwnerRequests.jsx');
  const row = { requestType: 'property_visit', listing: { title: 'Owner property', type: 'property', host: 'approved-owner', location: 'Mulund West, Mumbai, Maharashtra' }, createdAt: '2026-10-24T15:05:00.000Z', startDate: '2026-10-26', status: 'pending' };
  const before = JSON.stringify(row);
  const html = render(OwnerRequestCard, { row });
  for (const value of ['<dt>Property Location</dt><dd>Mulund West, Mumbai, Maharashtra</dd>', '<dt>Requested On</dt><dd>2026-10-24</dd>', '<dt>Requested At</dt><dd>08:35 PM</dd>', '<dt>Visit date</dt><dd>2026-10-26</dd>']) assert.ok(html.includes(value), value);
  const midnight = render(OwnerRequestCard, { row: { ...row, createdAt: '2026-10-24T18:30:00.000Z' } });
  assert.match(midnight, /Requested On<\/dt><dd>2026-10-25/);
  assert.match(midnight, /Requested At<\/dt><dd>12:00 AM/);
  for (const createdAt of [undefined, null, '', 'invalid timestamp']) {
    const legacy = render(OwnerRequestCard, { row: { ...row, createdAt, listing: { ...row.listing, location: ' ' } } });
    assert.equal((legacy.match(/<dd>Not available<\/dd>/g) || []).length, 3);
  }
  const vehicle = render(OwnerRequestCard, { row: { ...row, requestType: 'vehicle', listing: { ...row.listing, type: 'vehicle' } } });
  assert.doesNotMatch(vehicle, /Property Location|Requested On|Requested At/);
  const booking = render(OwnerRequestCard, { row: { ...row, requestType: 'property_booking' } });
  assert.doesNotMatch(booking, /Property Location|Requested On|Requested At/);
  assert.equal(JSON.stringify(row), before);
});

test('compact owner request cards retain contact, fulfilment and dates with Accept/Reject only for pending requests', async () => {
  const { OwnerRequestCard } = await vite.ssrLoadModule('/src/components/OwnerRequests.jsx');
  for (const type of ['property', 'vehicle']) for (const status of ['pending', 'confirmed', 'rejected', 'cancelled']) {
    const row = { listing: { title: 'Owner request fixture', type }, contact: { name: 'Actual Customer', email: 'customer@example.test', phone: '9876543210' }, startDate: '2092-01-01', endDate: '2092-01-04', totalPrice: 3150, fulfilment: 'delivery', deliveryAddress: 'Complete delivery address', status };
    const html = render(OwnerRequestCard, { row, busy: false, decide() {} });
    for (const value of [row.listing.title, row.contact.name, row.contact.email, row.contact.phone, '2092-01-01']) assert.ok(html.includes(value), value);
    assert.equal(html.includes('>Accept<'), status === 'pending'); assert.equal(html.includes('>Reject<'), status === 'pending');
    assert.equal(html.includes('Remove request from owner history'), status !== 'pending');
    if (status !== 'pending') assert.match(html, /class="history-remove"[^>]*>[\s\S]*?<svg[^>]*width="15"[\s\S]*?M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7[\s\S]*?<\/svg><span>Remove<\/span>/);
    if (type === 'vehicle') for (const value of ['2092-01-04', '₹3,150', 'Complete delivery address', 'Fulfilment']) assert.ok(html.includes(value), value);
    else assert.match(html, /Visit date/);
  }
});

test('saved decision notifications render correct type/status, safe WhatsApp contacts and independent dismissal', async () => {
  const { RequestNotificationCard } = await vite.ssrLoadModule('/src/components/RequestNotifications.jsx');
  for (const type of ['property', 'vehicle']) for (const status of ['confirmed', 'rejected']) {
    const row = { _id: 'notice-ui', requestType: type === 'property' ? 'property_visit' : 'vehicle', status, startDate: '2096-02-01', endDate: '2096-02-03', listing: { _id: 'owner-listing', hostingDetailsVersion: 1, host: 'owner', phone: '9876543210', title: 'Actual ' + type, type } };
    const html = render(RequestNotificationCard, { row, busy: false, onDismiss() {} });
    assert.ok(html.includes('Actual ' + type)); assert.match(html, /Dismiss request notification/);
    if (status === 'confirmed') {
      assert.match(html, /Contact Owner on WhatsApp/); assert.match(html, /https:\/\/wa.me\/919876543210/);
      assert.match(html, type === 'property' ? /Your Property Visit Has Been Approved!/ : /Your Booking Request Has Been Accepted!/);
      assert.doesNotMatch(render(RequestNotificationCard, { row: { ...row, listing: { ...row.listing, phone: '' } }, onDismiss() {} }), /href="https:\/\/wa.me/);
    } else assert.match(html, type === 'property' ? /Your Property Visit Request Has Been Rejected/ : /Your Booking Request Has Been Rejected/);
    assert.doesNotMatch(render(RequestNotificationCard, { row: { ...row, listing: null }, onDismiss() {} }), /href="https:\/\/wa.me/);
  }
  const { requestNotification } = await import('../../src/data/requestNotifications.js');
  const legacy = requestNotification({ requestType: 'vehicle', status: 'confirmed', listing: { _id: '6ad4ac1d98166bf0d4230f11', title: 'Predefined vehicle' } });
  assert.match(legacy.contactUrl, /wa.me\/919403570134/);
  assert.ok(decodeURIComponent(legacy.contactUrl).includes('Predefined vehicle'));
});


test('three dashboard Delete All locations share an accessible persistent-hiding confirmation and existing wrapping toolbars', async () => {
  const {default:CustomerRequests}=await vite.ssrLoadModule('/src/components/CustomerRequests.jsx');
  const {default:OwnerRequests}=await vite.ssrLoadModule('/src/components/OwnerRequests.jsx');
  const {default:Confirmation}=await vite.ssrLoadModule('/src/components/HistoryConfirmation.jsx');
  for(const component of [CustomerRequests,OwnerRequests]) {
    const html=render(component,{});assert.match(html,/>Refresh<.*>Delete All</);assert.match(html,/disabled=""[^>]*>Delete All/);
  }
  const dashboard=await readFile(new URL('../../src/components/UserDashboard.jsx',import.meta.url),'utf8');
  assert.equal((dashboard.match(/<CustomerRequests \/>/g)||[]).length,2,'one shared outgoing section per user/owner dashboard');
  assert.equal((dashboard.match(/<OwnerRequests \/>/g)||[]).length,1);
  const html=render(Confirmation,{bulk:true,busy:false,onClose(){},onConfirm(){}});
  assert.match(html,/Delete All Requests?/);assert.match(html,/These requests will be removed from your dashboard. Existing booking records will remain unchanged./);
  assert.match(html,/>Cancel<.*>Delete All</);assert.match(html,/role="dialog" aria-modal="true"/);
  const release=render(Confirmation,{release:{startDate:'2099-12-20',endDate:'2099-12-23'},busy:false,onClose(){},onConfirm(){}});
  assert.match(release,/Make Dates Available?/);assert.match(release,/2099-12-20.*2099-12-23/);assert.match(release,/>Cancel<.*>Make Available</);
});

test('bulk dashboard hiding verifies responses and keeps the confirmed request snapshot scoped to its session', async () => {
  const {hideDashboardRequests}=await import('../../src/data/requestHistory.js');
  const ids=['507f1f77bcf86cd799439011'];
  for(const direction of ['customer','owner']) {
    const hidden=await hideDashboardRequests({ids,direction,kind:'vehicle',token:'mock-only',send:async(url,options)=>{
      assert.equal(url,'/api/bookings/hide-all');assert.deepEqual(JSON.parse(options.body),{ids,direction,kind:'vehicle'});return new Response(JSON.stringify({hiddenIds:ids}));
    }});assert.deepEqual(hidden,ids);
  }
  await assert.rejects(hideDashboardRequests({ids,send:async()=>new Response(JSON.stringify({message:'Refresh and retry'}),{status:503})}),/Refresh and retry/);
  await assert.rejects(hideDashboardRequests({ids,send:async()=>new Response('<html>')}),/Refresh and retry/i);
  for(const component of ['CustomerRequests','OwnerRequests']) {
    const source=await readFile(new URL('../../src/components/'+component+'.jsx',import.meta.url),'utf8');
    const handler=source.match(/const hideAll = async \(\) => \{[\s\S]*?\n  \};/)?.[0];assert.ok(handler);
    const create=new Function('deps','with(deps){'+handler+'; return hideAll;}');
    let calls=0,finish,closed=false,rows=[{_id:ids[0]},{_id:'other'}];
    const deps={busy:false,bulk:{ids,kind:'vehicle',token:'mock-only'},bulkLock:{current:null},user:{token:'mock-only'},tokenRef:{current:'mock-only'},sequence:{current:0},requestSequence:{current:0},setBusy(){},setActionError(){},setRemoveError(){},setRows:fn=>{rows=fn(rows);},closeModal:()=>{closed=true;},closeRemove:()=>{closed=true;},load:async()=>{},hideDashboardRequests:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
    const submit=create(deps),first=submit();await submit();assert.equal(calls,1);finish(ids);await first;assert.ok(closed);assert.deepEqual(rows,[{_id:'other'}]);
    closed=false;deps.bulk.token='old-session';await submit();assert.equal(calls,1);assert.equal(closed,false);
  }
});


test('manual hosting address edits invalidate pins for properties and vehicles; unrelated edits retain the saved location', async () => {
  const source=await readFile(new URL('../../src/components/HostingForm.jsx',import.meta.url),'utf8');
  const handler=source.split(String.fromCharCode(10)).find(line=>line.includes('const change = '));assert.ok(handler);
  const create=new Function('deps','with(deps){'+handler+';return change;}');
  for(const type of ['property','vehicle']) {
    const form=hostingValues(hostingFixture(type)),updates=[];
    const change=create({form,setForm:value=>updates.push(value)});
    change('price',1250);assert.deepEqual(updates[0].locationCoordinates,form.locationCoordinates);assert.equal(updates[0].location,form.location);
    change('location','Manually replaced address');assert.equal(updates[1].locationCoordinates,null);
  }
  const app=await readFile(new URL('../../src/App.jsx',import.meta.url),'utf8');
  assert.ok(app.includes('isProperty && pickupLocationUrl(item.locationCoordinates)'));assert.match(app,/View Property Location/);
});


test('owner validation is shared, field-specific, preserves optional business name, and validates saved document reuse', async () => {
  const {ownerProfileErrors,ownerDocumentErrors,ownerFileError,ownerListingTypes}=await import('../../src/data/ownerPolicy.js');
  const values={phone:'+91 98765-43210',address:'Complete address',city:'Mumbai',state:'Maharashtra',bio:'Owner bio',listingIntent:'property',businessName:''};
  assert.deepEqual(ownerProfileErrors(values),{});
  for(const key of ['phone','address','city','state','bio','listingIntent'])assert.ok(ownerProfileErrors({...values,[key]:'  '})[key]);
  assert.ok(ownerProfileErrors({...values,phone:'1234567890'}).phone);
  assert.ok(ownerDocumentErrors({idProofType:'PAN Card',idProofNumber:'Saved'},[]).documents);
  assert.deepEqual(ownerDocumentErrors({idProofType:'PAN Card',idProofNumber:'Saved'},['owner-document:saved']),{});
  assert.ok(ownerFileError([{type:'text/html',size:10}]));assert.ok(ownerFileError([{type:'image/png',size:6*1024*1024}]));
  assert.deepEqual(ownerListingTypes({listingIntent:' Properties / Rooms '}),['property']);assert.deepEqual(ownerListingTypes({listingIntent:'VEHICLES'}),['vehicle']);assert.deepEqual(ownerListingTypes({}),[]);
});

test('completed owner wizard steps are accessible buttons; current step remains distinct and future steps remain disabled', async () => {
  const {Stepper}=await vite.ssrLoadModule('/src/components/OwnerOnboarding.jsx');
  let selected;const tree=Stepper({current:3,completed:3,onSelect:value=>{selected=value;}});
  const steps=tree.props.children;
  for(let i=0;i<steps.length;i++){const button=steps[i].props.children[0];assert.equal(button.type,'button');assert.equal(button.props.disabled,i>=2);if(i===0)button.props.onClick();}
  assert.equal(selected,1);
  const submitted=render(Stepper,{current:2,completed:5,onSelect(){}});assert.equal((submitted.match(/disabled=""/g)||[]).length,2);assert.ok(submitted.includes('aria-current="step"'));assert.ok(submitted.includes('var(--green)'));
  const {default:Form}=await vite.ssrLoadModule('/src/components/HostingForm.jsx');
  for(const intent of ['property','vehicle','both','']) {
    const html=render(Form,{token:'ui-only'},'/owner-dashboard',{role:'owner',ownerProfile:{status:'approved',listingIntent:intent}});
    assert.equal(html.includes('Room / Property'),['property','both'].includes(intent));assert.equal(html.includes('Car / Bike / Vehicle'),['vehicle','both'].includes(intent));
    assert.equal(html.includes('Publish Product'),Boolean(intent));
  }
  assert.ok(render(Form,{token:'ui-only'},'/admin',{role:'admin'}).includes('Car / Bike / Vehicle'));
  for(const role of ['user','owner'])assert.ok(!render(Form,{token:'ui-only'},'/dashboard',{role,ownerProfile:{status:'pending',listingIntent:'both'}}).includes('Publish Product'));
});

test('private document preview sends JWT headers, preserves image/PDF types, closes failed tabs, and revokes temporary URLs', async () => {
  const {openPrivateOwnerDocument}=await import('../../src/data/ownerDocuments.js');
  for(const type of ['image/png','application/pdf']) {
    const calls=[],revoked=[],tab={closed:false,opener:'old',location:{replace:url=>calls.push(url)},close(){this.closed=true;}};
    let check;
    const cleanup=await openPrivateOwnerDocument({ownerId:'owner-fixture',index:1,token:'mock-only',open:()=>tab,createUrl:blob=>{assert.equal(blob.type,type);return 'blob:private-fixture';},revokeUrl:url=>revoked.push(url),repeat:fn=>{check=fn;return 1;},stop(){},later(){},send:async(url,options)=>{
      assert.equal(url,'/api/owner/documents/owner-fixture/1');assert.ok(!url.includes('mock-only'));assert.equal(options.headers.Authorization,'Bearer mock-only');return new Response(new Blob(['fixture'],{type}));
    }});
    assert.equal(tab.opener,null);assert.deepEqual(calls,['blob:private-fixture']);tab.closed=true;check();cleanup();assert.deepEqual(revoked,['blob:private-fixture']);
  }
  for(const status of [401,403,404]) {
    let closed=false,created=false;
    await assert.rejects(openPrivateOwnerDocument({ownerId:'fixture',index:0,token:'mock-only',open:()=>({close(){closed=true;}}),createUrl:()=>{created=true;},send:async()=>new Response('{}',{status})}));assert.ok(closed);assert.equal(created,false);
  }
});

test('owner wizard focuses and scrolls to its first invalid field without discarding values or uploaded files', async () => {
  const source=await readFile(new URL('../../src/components/OwnerOnboarding.jsx',import.meta.url),'utf8');
  const start=source.indexOf('  const showErrors = '),end=source.indexOf('  const clearField = ',start),handler=source.slice(start,end);
  const create=new Function('deps','with(deps){'+handler+';return showErrors;}');
  let focused=false,scrolled=false,errors;
  const show=create({setFieldErrors:value=>{errors=value;},requestAnimationFrame:fn=>fn(),root:{current:{querySelector:selector=>{assert.equal(selector,'[name="address"]');return{focus(){focused=true;},scrollIntoView(){scrolled=true;}};}}}});
  assert.equal(show({address:'Enter address',city:'Enter city'}),true);assert.ok(focused&&scrolled);assert.equal(errors.city,'Enter city');
  assert.ok(source.includes('disabled={readOnly || submitting}'));assert.ok(source.includes('Enter your complete address'));assert.ok(source.includes('setDocForm({ idProofType: data.ownerProfile?.idProofType'));
});


test('owner indicators allow all saved completed steps and block incomplete steps; failed or read-only submission is explicit', async () => {
  const {Stepper}=await vite.ssrLoadModule('/src/components/OwnerOnboarding.jsx');
  for (const [current, completed, allowed] of [[4,4,[1,2,3]], [2,4,[1,3]], [3,4,[1,2]], [2,5,[1,3,4]], [1,1,[]]]) {
    const clicks = [];
    const saved = { address: 'Saved address', documents: ['owner-document:saved'], completed };
    const before = JSON.stringify(saved);
    const indicators = Stepper({ current, completed: saved.completed, onSelect: value => clicks.push(value) });
    for (const [index, row] of indicators.props.children.entries()) {
      const button = row.props.children[0];
      assert.equal(button.props.disabled, !allowed.includes(index + 1));
      button.props.onClick(); // Also enforce the rule if a disabled handler is invoked directly.
      if (allowed.includes(index + 1)) assert.equal(button.props.children[0].props.style.background, 'var(--green)');
    }
    assert.deepEqual(clicks, allowed);
    assert.equal(JSON.stringify(saved), before, 'indicator navigation does not write progress or saved data');
  }
  const unvalidated = Stepper({ current: 4, onSelect() { throw new Error('Visiting is not completion'); } });
  for (const row of unvalidated.props.children) { assert.equal(row.props.children[0].props.disabled, true); row.props.children[0].props.onClick(); }
  const visited=[];const tree=Stepper({current:3,completed:5,onSelect:value=>visited.push(value)});
  for(const row of tree.props.children)row.props.children[0].props.onClick();
  assert.deepEqual(visited,[1,2,4]);
  const busy=Stepper({current:5,completed:5,disabled:true,onSelect:value=>visited.push(value)});
  for(const row of busy.props.children)row.props.children[0].props.onClick();assert.deepEqual(visited,[1,2,4]);
  const source=await readFile(new URL('../../src/components/OwnerOnboarding.jsx',import.meta.url),'utf8');
  const start=source.indexOf('  const finalSubmit = '),end=source.indexOf('  if (loading)',start),handler=source.slice(start,end);
  const create=new Function('deps','with(deps){'+handler+'; return finalSubmit;}');
  let error='',step,calls=0;
  const deps={readOnly:true,setError:value=>{error=value;},setStep:value=>{step=value;},fetch:async()=>{calls++;}};
  await create(deps)();assert.ok(error.includes('already submitted'));assert.equal(step,5);assert.equal(calls,0);
  Object.assign(deps,{readOnly:false,ownerProfileErrors:()=>({address:'Please enter your complete address.'}),ownerDocumentErrors:()=>({}),profileForm:{},docForm:{},ownerData:{},showErrors:errors=>{error=errors.address;}});
  await create(deps)();assert.equal(step,2);assert.ok(error.includes('address'));assert.equal(calls,0);
  Object.assign(deps,{ownerProfileErrors:()=>({}),statusSequence:{current:0},setSubmitting(){},setSuccess(){},user:{token:'mock-only'},fetch:async()=>{calls++;return new Response(JSON.stringify({message:'Please retry submission.'}),{status:503});}});
  await create(deps)();assert.equal(error,'Please retry submission.');assert.equal(calls,1);
  assert.ok(source.includes("onClick={status === 'revoked' ? startAsExistingUser"));
  assert.ok(source.includes("status === 'pending' ? ("));
});


test('property and vehicle browsing omit only Pune/Delhi city options and retain Mumbai-region areas and existing listings', async () => {
  const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
  const { CITIES } = await vite.ssrLoadModule('/src/data/locations.js');
  const { properties, vehicles } = await vite.ssrLoadModule('/src/data/listings.js');
  const before = JSON.stringify({ CITIES, properties, vehicles });
  const previousWindow = globalThis.window, previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem() { return null; } };
  try {
    for (const [path, rows] of [['/properties', properties], ['/vehicles', vehicles]]) {
      globalThis.window = { location: { search: '' } };
      const html = render(App, {}, path);
      const cities = html.match(/<select[^>]*aria-label="Filter by city"[^>]*>([\s\S]*?)<\/select>/)?.[1];
      assert.ok(cities);
      assert.doesNotMatch(cities, /Pune|Delhi/i);
      for (const city of CITIES.filter(city => !['pune', 'delhi'].includes(city.name.trim().toLowerCase()))) assert.ok(cities.includes(`value="${city.name}"`));
      for (const row of rows) assert.ok(html.includes(`href="${path}/${row.id}"`), `All cities still includes ${row.id}`);
      globalThis.window.location.search = '?city=Mumbai';
      const mumbai = render(App, {}, path + '?city=Mumbai');
      for (const area of ['Navi Mumbai', 'Thane', 'Andheri', 'Bandra']) assert.ok(mumbai.includes(`value="${area}"`));
      assert.ok(mumbai.includes('Price: low to high')); assert.ok(mumbai.includes('Price: high to low'));
    }
    assert.equal(JSON.stringify({ CITIES, properties, vehicles }), before);
  } finally {
    globalThis.window = previousWindow; globalThis.localStorage = previousStorage;
  }
});

test('owner status reload keeps unfinished reapplications editable and ignores older pending responses after restart', async () => {
  const source=await readFile(new URL('../../src/components/OwnerOnboarding.jsx',import.meta.url),'utf8');
  const start=source.indexOf('  const refreshStatus = '),end=source.indexOf('  useEffect(() => {',start),handler=source.slice(start,end);
  const create=new Function('deps','with(deps){'+handler+';return refreshStatus;}');
  let finish,loaded=null,step,completed;
  const deps={user:{token:'mock-only'},statusSequence:{current:0},setLoading(){},setError(){},setOwnerData:value=>{loaded=value;},setRegForm(){},setDocForm(){},setProfileForm(){},setStep:value=>{step=value;},setCompleted:value=>{completed=value;},fetch:()=>new Promise(resolve=>{finish=resolve;})};
  const stale=create(deps)();deps.statusSequence.current++;finish(new Response(JSON.stringify({ownerProfile:{status:'pending',currentStep:5}})));await stale;assert.equal(loaded,null);
  deps.fetch=async()=>new Response(JSON.stringify({ownerProfile:{status:'in_progress',currentStep:5}}));await create(deps)();assert.equal(step,4);assert.equal(completed,4);assert.equal(loaded.ownerProfile.status,'in_progress');
  deps.fetch=async()=>new Response(JSON.stringify({ownerProfile:{status:'pending',currentStep:5}}));await create(deps)();assert.equal(step,5);assert.equal(loaded.ownerProfile.status,'pending');
});
