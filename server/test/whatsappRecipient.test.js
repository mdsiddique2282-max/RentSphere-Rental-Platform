import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { whatsappRecipient } from '../../src/data/whatsappRecipient.js';
import { properties, vehicles } from '../../src/data/listings.js';

test('all original predefined database properties/vehicles use the existing contact despite hosts and missing catalog metadata/phone', async () => {
  const catalog = JSON.parse(await readFile(new URL('../catalog/original-listings.json', import.meta.url), 'utf8'));
  assert.equal(catalog.listings.length, 8);
  for (const row of catalog.listings) {
    assert.ok(['property', 'vehicle'].includes(row.type));
    const fixture = { _id: row._id, host: 'existing-host', type: row.type };
    assert.equal(whatsappRecipient(fixture), '919403570134');
    assert.equal(whatsappRecipient({ ...fixture, phone: 'host@example.test' }), '919403570134');
    assert.equal(whatsappRecipient({ ...fixture, _id: undefined, id: row._id }), '919403570134');
  }
});

test('static, imported and sample properties/vehicles do not require an owner phone', () => {
  for (const row of [...properties, ...vehicles]) assert.equal(whatsappRecipient(row), '919403570134');
  for (const type of ['property', 'vehicle']) for (const marker of [{ inventoryKind: 'sample' }, { catalogKey: 'predefined-catalog-item' }, { legacyId: 'predefined-legacy-item' }]) {
    assert.equal(whatsappRecipient({ _id: 'catalog-id', host: 'catalog-host', type, ...marker }), '919403570134');
  }
});

test('owner-uploaded properties/vehicles use their own saved number and never silently fall back on missing/invalid contact', () => {
  for (const type of ['property', 'vehicle']) {
    const fixture = { _id: '507f1f77bcf86cd799439011', host: 'verified-owner', hostingDetailsVersion: 1, type };
    for (const phone of ['9876543210', '+91 98765 43210', '919876543210']) assert.equal(whatsappRecipient({ ...fixture, phone }), '919876543210');
    for (const phone of [undefined, '', 'owner@example.test', '1234567890', '987654321']) {
      assert.throws(() => whatsappRecipient({ ...fixture, phone }), /valid owner contact number/);
      // Older unmarked owner uploads must not be confused with the eight originals.
      assert.throws(() => whatsappRecipient({ ...fixture, hostingDetailsVersion: undefined, phone }), /valid owner contact number/);
    }
  }
});

// Exercise the actual UI handler without a browser or changing its closure/state flow.
const appSource = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const decisionHandler = appSource.match(/const openDecisionWhatsApp = \(\) => \{[\s\S]*?\n\};(?=\s*const confirmPreviewDecision)/)?.[0];
assert.ok(decisionHandler, 'Property Details decision handler must be present');
const createDecisionHandler = new Function('item', 'visitDecision', 'whatsappRecipient', 'window', 'isolated',
  'setDecisionShared', 'declineProperty', 'setVisitDecision', 'setDecisionError', `${decisionHandler}\nreturn openDecisionWhatsApp;`);

function shareDecision(item, decision, isolated = true) {
  const calls = { opened: [], shared: [], declined: [], decision: [], errors: [] };
  createDecisionHandler(item, decision, whatsappRecipient, { open: (...args) => calls.opened.push(args) }, isolated,
    value => calls.shared.push(value), () => calls.declined.push(true), value => calls.decision.push(value),
    value => calls.errors.push(value))();
  return calls;
}

for (const decision of ['interested', 'not-interested']) {
  test(`${decision} uses the Visit Request recipient for owner-uploaded and predefined properties, preserving message and save flow`, async () => {
    const visitSource = await readFile(new URL('../../src/components/PropertyVisitModal.jsx', import.meta.url), 'utf8');
    assert.match(visitSource, /const recipient = whatsappRecipient\(item\)/);
    assert.match(appSource, /import \{ whatsappRecipient \} from ['"]\.\/data\/whatsappRecipient['"]/);
    const fixtures = [
      { _id: '507f1f77bcf86cd799439011', host: 'owner', hostingDetailsVersion: 1, phone: '+91 98765 43210' },
      { _id: '507f1f77bcf86cd799439012', host: 'older-owner', phone: '9876543210' },
      { _id: '6ad4ac1d98166bf0d4230f0f', host: 'legacy-host' },
      { _id: 'sample', inventoryKind: 'sample', host: 'sample-host' },
      { _id: 'catalog', catalogKey: 'original-property', host: 'catalog-host' },
      ...properties,
    ];
    for (const fixture of fixtures) {
      const item = { ...fixture, title: 'Test Property', status: 'available' };
      const before = structuredClone(item);
      const calls = shareDecision(item, decision);
      assert.equal(calls.opened.length, 1);
      const [link, target, options] = calls.opened[0];
      const url = new URL(link);
      assert.equal(url.origin + url.pathname, `https://wa.me/${whatsappRecipient(item)}`);
      assert.equal(url.searchParams.get('text'), decision === 'interested'
        ? 'Hello, I requested a visit for your property "Test Property" on RentSphere. After visiting, I am interested in renting it.\n\nI would like to know if there are any offers available or if the rent is negotiable.\n\nPlease contact me to discuss the rent, payment, agreement and next steps.'
        : 'Hello, I requested a visit for your property "Test Property" on RentSphere. After visiting, I have decided not to proceed. Thank you for your time.');
      assert.equal(target, '_blank');
      if (decision === 'interested') {
        const message = url.searchParams.get('text');
        assert.equal(message.split('\n\n').length, 3);
        assert.equal(message.split('I would like to know if there are any offers available or if the rent is negotiable.').length - 1, 1);
        assert.ok(!message.includes('\n\n\n'));
      }
      assert.equal(options, 'noopener,noreferrer');
      assert.deepEqual(calls.shared, [true]);
      assert.deepEqual(calls.declined, []);
      assert.deepEqual(calls.decision, []);
      assert.deepEqual(calls.errors, []);
      assert.deepEqual(item, before, 'sharing must not mark a property rented/unavailable');
    }
  });

  test(`${decision} blocks invalid owner contacts without falling back or advancing the decision`, () => {
    for (const isolated of [true, false]) for (const phone of [undefined, '', 'invalid', '1234567890']) {
      const item = { _id: '507f1f77bcf86cd799439011', host: 'owner', hostingDetailsVersion: 1, phone, status: 'available' };
      const calls = shareDecision(item, decision, isolated);
      assert.deepEqual(calls.opened, []);
      assert.deepEqual(calls.shared, []);
      assert.deepEqual(calls.declined, []);
      assert.deepEqual(calls.decision, []);
      assert.equal(calls.errors.length, 1);
      assert.match(calls.errors[0], /valid owner contact number/);
      assert.equal(item.status, 'available');
    }
  });
}
