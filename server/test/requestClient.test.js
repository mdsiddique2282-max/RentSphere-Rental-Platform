import test from 'node:test';
import assert from 'node:assert/strict';
import { requestToday, validateRequest, saveRequest, reserveWhatsapp, showWhatsapp, readRequestDraft, writeRequestDraft, clearRequestDraft, previewVisitMessage, appendRequestLink, requestReturnPath, resolveRequestLink } from '../../src/data/requests.js';
import { readFile } from 'node:fs/promises';
import { isCoordinates } from '../../src/data/coordinates.js';
import { isListingUnavailable } from '../../src/data/detailHeader.js';
import { submitAuthentication } from '../../src/data/authentication.js';

const user = { token: 'test-token' };
const body = { listingId: '507f1f77bcf86cd799439011', startDate: '2090-01-01', endDate: '2090-01-02' };

test('direct links append exactly one line after untouched messages and use localhost, LAN or deployed frontend origin', () => {
  const id = 'a'.repeat(24);
  const original = previewVisitMessage({ title: 'Original property', location: 'Original address' }, { name: 'Customer', phone: '9876543210', email: 'fixture@example.test', start: '2090-01-01' });
  for (const origin of ['http://localhost:5173', 'http://192.168.1.20:5173', 'https://rentsphere.example']) {
    const result = appendRequestLink(original, { _id: id }, origin);
    assert.equal(result, original + '\nRequest Link: ' + origin + '/request/' + id);
    assert.equal(Buffer.compare(Buffer.from(result.slice(0, original.length)), Buffer.from(original)), 0);
    assert.equal(result.match(/Request Link:/g).length, 1);
  }
  for (const value of ['https://evil.test/request/' + id, '//evil.test', '/request/bad', '/request/' + id + '?redirect=https://evil.test']) assert.equal(requestReturnPath(value), '');
  assert.equal(requestReturnPath('/request/' + id), '/request/' + id);
});

test('direct-link resolution fails safely for invalid IDs, missing requests, unrelated roles, HTML and API failures', async () => {
  const id = 'a'.repeat(24), calls = [];
  const send = async path => { calls.push(path); return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => [] }; };
  await assert.rejects(resolveRequestLink({ id: 'invalid', send }), /unavailable/); assert.equal(calls.length, 0);
  for (const account of [{ role: 'user' }, { role: 'owner', ownerProfile: { status: 'pending' } }, { role: 'owner', ownerProfile: { status: 'rejected' } }]) {
    calls.length = 0; await assert.rejects(resolveRequestLink({ id, account, token: 'test', send }), /unavailable/);
    assert.deepEqual(calls, ['/api/bookings/mybookings']);
  }
  for (const response of [{ ok: true, headers: new Headers({ 'content-type': 'text/html' }) }, { ok: false, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ message: 'Private detail' }) }]) {
    await assert.rejects(resolveRequestLink({ id, token: 'test', send: async () => response }), /Unable to open this request/);
  }
});

test('existing login handler returns users and owners to the exact link and rejects external return destinations', async () => {
  const source = await readFile(new URL('../../src/components/AuthForm.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const submit=async e=>{'), end = source.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start);
  const create = new Function('deps', `with(deps) { ${source.slice(start, end + 5)}; return submit; }`);
  const id = 'a'.repeat(24);
  for (const role of ['user', 'owner']) for (const destination of ['/request/' + id, 'https://evil.test', '//evil.test', '/request/invalid']) {
    const visited = [], logged = [];
    const deps = { register: false, values: { email: 'fixture@example.test', password: 'ChosenPassword!' }, inFlight: { current: false },
      location: { search: '?returnTo=' + encodeURIComponent(destination) }, requestReturnPath,
      setSubmitting() {}, setError() {}, setSuccess() {}, login: data => logged.push(data), navigate: path => visited.push(path), notifyToast() {},
      submitAuthentication: options => submitAuthentication({ ...options, fetcher: async () => ({ ok: true, json: async () => ({ _id: 'fixture', token: 'mock-only', role }) }) }) };
    await create(deps)({ preventDefault() {} });
    assert.deepEqual(visited, [requestReturnPath(destination) || '/dashboard']); assert.equal(logged.length, 1);
  }
  const dashboard = await readFile(new URL('../../src/components/UserDashboard.jsx', import.meta.url), 'utf8');
  assert.match(dashboard, /to=\{`\/login\?returnTo=\$\{encodeURIComponent\(path\)\}`\}/);
  assert.match(dashboard, /let active = true/); assert.match(dashboard, /active = false/);
  assert.match(dashboard, /result\?\.scope === scope/);
});

test('exact-request hook selects the section, scrolls/focuses only authorized returned rows and survives remount', async t => {
  const source = await readFile(new URL('../../src/data/requests.js', import.meta.url), 'utf8');
  const hookSource = source.slice(source.indexOf('export function useLinkedRequest'), source.indexOf('const draftLifetime')).replace('export ', '');
  const id = 'a'.repeat(24), row = { _id: id }, actions = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { getElementById: key => { actions.push(key); return { scrollIntoView: () => actions.push('scroll'), focus: () => actions.push('focus') }; } };
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
  for (const view of ['owner', 'customer']) for (const type of ['property', 'vehicle']) {
    const effects = [], filters = [];
    const hook = new Function('useRef', 'useEffect', hookSource + '; return useLinkedRequest;')(() => ({ current: '' }), fn => effects.push(fn));
    const options = { search: `?request=${id}&view=${view}&type=${type}`, view, rows: [row], loading: false, error: '', token: 'test', setType: value => filters.push(value), setGroup: value => filters.push(value) };
    assert.equal(hook(options).linkedRow, row); effects.forEach(fn => fn()); assert.equal(filters[0], type); assert.ok(actions.includes(`request-${view}-${id}`));
    actions.length = 0; effects.length = 0;
    assert.equal(hook({ ...options, rows: [] }).unavailable, true); effects.forEach(fn => fn()); assert.equal(actions.length, 0);
    effects.length = 0; assert.equal(hook({ ...options, rows: [], loading: true }).unavailable, false);
  }
});

test('client refuses anonymous, demo, past, impossible and reversed requests without calling the API', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
  for (const change of [
    { user: null }, { listingId: 'V101' }, { startDate: '2000-01-01' },
    { startDate: '2090-02-30' }, { endDate: '2089-12-31' },
  ]) {
    await assert.rejects(saveRequest({ user, ...body, ...change }));
  }
  assert.equal(network.mock.callCount(), 0);
  assert.doesNotThrow(() => validateRequest({ user, ...body, startDate: requestToday(), endDate: requestToday() }));
  assert.equal(requestToday(new Date('2026-10-20T18:30:00Z')), '2026-10-21');
});

test('client submits bookings/visits with the current token and retains contact and delivery details', async t => {
  const saved = { requestId: 'test-request-id', status: 'pending' };
  const network = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => saved }));
  for (const isVisit of [false, true]) {
    const contact = { name: 'Customer', email: 'test@example.test', phone: '9999999999' };
    const result = await saveRequest({ user, isVisit, ...body, contact, fulfilment: 'delivery', deliveryAddress: 'Test address' });
    assert.deepEqual(result, saved);
    const [url, options] = network.mock.calls.at(-1).arguments;
    assert.equal(url, isVisit ? '/api/bookings/visits' : '/api/bookings');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(options.body), { ...body, contact, fulfilment: 'delivery', deliveryAddress: 'Test address' });
  }
});

test('client propagates duplicate, expired-session, malformed-response and network failures instead of reporting success', async t => {
  for (const message of ['Already requested', 'Please log in', 'Database unavailable']) {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, json: async () => ({ message }) }));
    await assert.rejects(saveRequest({ user, ...body }), { message });
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network failed'); });
  await assert.rejects(saveRequest({ user, ...body }), /Network failed/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } }));
  await assert.rejects(saveRequest({ user, ...body }), /Invalid JSON/);
});

test('WhatsApp tab reservation preserves manual sending and handles blocked popup fallback', t => {
  const popup = { opener: {}, closed: false, location: { href: 'about:blank' } };
  const opened = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = { open: (...args) => { opened.push(args); return popup; } };
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  });
  const reserved = reserveWhatsapp();
  assert.equal(reserved, popup);
  assert.equal(popup.opener, null);
  assert.equal(opened[0][0], 'about:blank');
  const url = 'https://wa.me/919403570134?text=Test';
  showWhatsapp(reserved, url);
  assert.equal(popup.location.href, url);
  assert.equal(opened.length, 1);
  showWhatsapp(null, url);
  assert.deepEqual(opened[1], [url, '_blank', 'noopener,noreferrer']);
});

const draftUser = { _id: 'a'.repeat(24), token: 'authentication-must-not-be-stored' };
const draftItem = { _id: 'b'.repeat(24), status: 'available', available: true };
const vehicleForm = { name: 'Draft Customer', email: 'draft@example.test', phone: '9876543210', start: '2091-01-01', end: '2091-01-03', fulfilment: 'pickup', address: '' };
const memoryStorage = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

test('temporary drafts preserve pickup/delivery/visit fields and coordinates across reload, scoped to the account, listing and request kind', () => {
  const storage = memoryStorage();
  for (const fulfilment of ['pickup', 'delivery']) {
    const form = { ...vehicleForm, fulfilment, address: fulfilment === 'delivery' ? 'Confirmed delivery address' : '' };
    const coordinates = fulfilment === 'delivery' ? { lat: 19.1, lon: 72.9 } : null;
    writeRequestDraft(draftUser, draftItem, 'vehicle', { form: { ...form, password: 'must-not-be-stored' }, coordinates, token: draftUser.token, quote: { quoteId: 'must-not-be-stored' } }, storage);
    assert.deepEqual(readRequestDraft(draftUser, draftItem, 'vehicle', storage), { form, coordinates });
    const raw = [...storage.values.values()][0];
    assert.doesNotMatch(raw, /authentication-must-not-be-stored|must-not-be-stored|password|quoteId|token/);
    assert.equal(readRequestDraft({ _id: 'other-account' }, draftItem, 'vehicle', storage), null);
    assert.equal(readRequestDraft(draftUser, { _id: 'other-listing' }, 'vehicle', storage), null);
    assert.equal(readRequestDraft(draftUser, draftItem, 'property_visit', storage), null);
  }
  const form = { name: 'Visit Customer', email: 'visit@example.test', phone: '9876543210', start: '2091-01-01' };
  writeRequestDraft(draftUser, draftItem, 'property_visit', { form }, storage);
  assert.deepEqual(readRequestDraft(draftUser, draftItem, 'property_visit', storage), { form, coordinates: null });
});

test('expired, corrupt, past/impossible/reversed-date and invalid-coordinate drafts never restore; submission removes editable details', () => {
  for (const change of [{ start: '2000-01-01' }, { start: '2091-02-30' }, { end: '2090-12-31' }, { fulfilment: 'invalid' }]) {
    const storage = memoryStorage(); writeRequestDraft(draftUser, draftItem, 'vehicle', { form: { ...vehicleForm, ...change } }, storage);
    assert.equal(readRequestDraft(draftUser, draftItem, 'vehicle', storage), null);
  }
  const storage = memoryStorage(), now = Date.now();
  writeRequestDraft(draftUser, draftItem, 'vehicle', { form: vehicleForm, coordinates: { lat: 91, lon: 72 } }, storage);
  assert.equal(storage.values.size, 0);
  writeRequestDraft(draftUser, draftItem, 'vehicle', { form: vehicleForm }, storage, now);
  assert.equal(readRequestDraft(draftUser, draftItem, 'vehicle', storage, now + 30 * 60000), null);
  writeRequestDraft(draftUser, draftItem, 'vehicle', { form: vehicleForm }, storage);
  const key = [...storage.values.keys()][0]; storage.values.set(key, '{bad-json');
  assert.equal(readRequestDraft(draftUser, draftItem, 'vehicle', storage), null);
  writeRequestDraft(draftUser, draftItem, 'vehicle', { form: vehicleForm }, storage);
  writeRequestDraft(draftUser, draftItem, 'vehicle', { submitted: true }, storage);
  assert.deepEqual(readRequestDraft(draftUser, draftItem, 'vehicle', storage), { submitted: true });
  assert.doesNotMatch(storage.values.get(key), /Draft Customer|draft@example|9876543210|form|coordinates/);
  clearRequestDraft(draftUser, draftItem, 'vehicle', storage); assert.equal(storage.values.size, 0);
  const denied = { getItem() { throw new Error('Storage disabled'); }, setItem() { throw new Error('Storage disabled'); }, removeItem() { throw new Error('Storage disabled'); } };
  assert.doesNotThrow(() => writeRequestDraft(draftUser, draftItem, 'vehicle', { form: vehicleForm }, denied));
  assert.equal(readRequestDraft(draftUser, draftItem, 'vehicle', denied), null);
});

test('real draft hook restores form state after external navigation/remount, preserves failure drafts, and clears on cancellation/success', async t => {
  const storage = memoryStorage(), windowEvents = new Map(), documentEvents = new Map();
  for (const [key, value] of Object.entries({ sessionStorage: storage, window: { addEventListener: (name, fn) => windowEvents.set(name, fn), removeEventListener: name => windowEvents.delete(name) }, document: { visibilityState: 'hidden', addEventListener: (name, fn) => documentEvents.set(name, fn), removeEventListener: name => documentEvents.delete(name) } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  const source = (await readFile(new URL('../../src/data/requests.js', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replaceAll('export ', '');
  const create = options => {
    const slots = []; let cursor = 0, effects = [], cleanups = [], closes = 0;
    const deps = { isCoordinates, useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
      useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; }, useEffect(fn) { effects.push(fn); }, useCallback: fn => fn };
    const hook = new Function('deps', `with(deps) { ${source}; return useRequestDraft; }`)(deps);
    return { render() { cursor = 0; effects = []; const result = hook({ user: draftUser, item: draftItem, onClose: () => { closes++; }, ...options }); cleanups.forEach(clean => clean?.()); cleanups = effects.map(fn => fn()); return result; }, unmount() { cleanups.forEach(clean => clean?.()); }, get closes() { return closes; } };
  };
  for (const kind of ['vehicle', 'property_visit']) {
    const form = kind === 'vehicle' ? { ...vehicleForm, fulfilment: 'delivery', address: 'Saved delivery pin address' } : { name: vehicleForm.name, email: vehicleForm.email, phone: vehicleForm.phone, start: vehicleForm.start };
    const options = { kind, initialForm: kind === 'vehicle' ? { name: '', email: '', phone: '', start: '', end: '', fulfilment: 'pickup', address: '' } : { name: '', email: '', phone: '', start: '' } };
    let view = create(options), state = view.render(); state.setForm(form);
    if (kind === 'vehicle') state.setCoordinates({ lat: 19.1, lon: 72.9 });
    view.render(); windowEvents.get('pagehide')(); documentEvents.get('visibilitychange')(); view.unmount();
    view = create(options); state = view.render(); assert.deepEqual(state.form, form); assert.equal(state.done, false);
    if (kind === 'vehicle') assert.deepEqual(state.coordinates, { lat: 19.1, lon: 72.9 });
    // Opening an external app or a failed submission never calls setDone.
    windowEvents.get('pagehide')(); assert.ok(readRequestDraft(draftUser, draftItem, kind, storage)?.form);
    state.setDone(true); windowEvents.get('pagehide')(); view.unmount();
    view = create(options); state = view.render(); assert.equal(state.done, true); assert.deepEqual(state.form, options.initialForm);
    state.close(); assert.equal(view.closes, 1); assert.equal(readRequestDraft(draftUser, draftItem, kind, storage), null); view.unmount();
    view = create(options); state = view.render(); state.setForm(form); view.render(); state.close(); windowEvents.get('pagehide')();
    assert.equal(readRequestDraft(draftUser, draftItem, kind, storage), null); view.unmount();
  }
});

test('detail page reopens only a valid scoped form/success panel and mobile login alignment override stays mobile-only', async () => {
  const app = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  const body = app.match(/useEffect\(\(\) => \{\s*(const draft = item && readRequestDraft[\s\S]*?)\n  \}, \[item\?\._id/)?.[1]; assert.ok(body);
  const storage = memoryStorage();
  const check = (draft, item = draftItem) => { let visible; new Function('item', 'user', 'requestKind', 'readRequestDraft', 'isListingUnavailable', 'setBooking', body)(item, draftUser, 'vehicle', () => draft, isListingUnavailable, value => { visible = value; }); return visible; };
  writeRequestDraft(draftUser, draftItem, 'vehicle', { form: vehicleForm }, storage);
  assert.equal(check(readRequestDraft(draftUser, draftItem, 'vehicle', storage)), true);
  assert.equal(check(null), false); assert.equal(check({ form: vehicleForm }, { ...draftItem, available: false }), false);
  assert.equal(check({ submitted: true }, { ...draftItem, available: false }), true);
  const css = await readFile(new URL('../../src/index.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('@media(max-width:750px)'), css.indexOf('@media(max-width:768px)'));
  assert.match(block, /\.nav-links a\.nav-login\{justify-content:center;align-items:center\}/);
  assert.equal((css.match(/\.nav-links a\.nav-login/g) || []).length, 1);
  for (const file of ['BookingModal', 'PropertyVisitModal']) {
    const modal = await readFile(new URL('../../src/components/' + file + '.jsx', import.meta.url), 'utf8');
    assert.match(modal, /useRequestDraft\(/); assert.match(modal, /onMouseDown=\{close\}/); assert.match(modal, /onClick=\{close\}/);
  }
  const modal = await readFile(new URL('../../src/components/BookingModal.jsx', import.meta.url), 'utf8');
  assert.match(modal, /View Pickup Location/); assert.match(modal, /target="_blank" rel="noopener noreferrer"/);
});

test('property visit submission keeps drafts on failure, records success before WhatsApp and never repeats a saved request on return', async () => {
  const source = await readFile(new URL('../../src/components/PropertyVisitModal.jsx', import.meta.url), 'utf8');
  const handler = source.match(/const submit = async e => \{[\s\S]*?\n  \};/)?.[0]; assert.ok(handler);
  const create = new Function('deps', `with(deps) { ${handler}; return submit; }`);
  for (const fail of [false, true]) {
    const storage = memoryStorage(), form = { name: vehicleForm.name, email: vehicleForm.email, phone: vehicleForm.phone, start: vehicleForm.start };
    writeRequestDraft(draftUser, draftItem, 'property_visit', { form }, storage);
    let calls = 0, shared = 0, release;
    const pending = new Promise(resolve => { release = resolve; });
    const popup = { closed: false, close() { this.closed = true; } };
    const deps = { item: draftItem, user: draftUser, form, submissionLock: { current: false }, done: false,
      isIsolatedPreview: () => false, isListingUnavailable, validateRequest, whatsappRecipient: () => '919876543210', previewVisitMessage,
      appendRequestLink: (message, request) => appendRequestLink(message, request, 'https://rentsphere.example'),
      setError() {}, setSubmitting() {}, reserveWhatsapp: () => popup,
      setDone(value) { deps.done = value; writeRequestDraft(draftUser, draftItem, 'property_visit', { submitted: value }, storage); },
      saveRequest: async () => { calls++; await pending; if (fail) throw new Error('Mock save failure'); return { _id: 'a'.repeat(24), status: 'pending' }; },
      showWhatsapp: (_, url) => { shared++; assert.ok(url.startsWith('https://wa.me/919876543210?text=')); assert.equal(new URL(url).searchParams.get('text'), previewVisitMessage(draftItem, form) + '\nRequest Link: https://rentsphere.example/request/' + 'a'.repeat(24)); assert.deepEqual(readRequestDraft(draftUser, draftItem, 'property_visit', storage), { submitted: true }); }, onVisitRequested() {} };
    const submit = create(deps), first = submit({ preventDefault() {} });
    await submit({ preventDefault() {} }); assert.equal(calls, 1); assert.equal(shared, 0);
    release(); await first;
    if (fail) { assert.equal(shared, 0); assert.ok(popup.closed); assert.deepEqual(readRequestDraft(draftUser, draftItem, 'property_visit', storage).form, form); }
    else { assert.equal(shared, 1); await submit({ preventDefault() {} }); assert.equal(calls, 1); }
  }
});
