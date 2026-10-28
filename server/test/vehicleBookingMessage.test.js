import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { vehicleBookingMessage } from '../../src/data/vehicleBookingMessage.js';
import { vehicleBookingDetails, pickupLocationUrl } from '../../src/data/vehicleBookingDetails.js';
import { sampleNotice } from '../../src/data/catalog.js';
import { previewVisitMessage } from '../../src/data/requests.js';
import { whatsappRecipient } from '../../src/data/whatsappRecipient.js';
import { reserveWhatsapp, showWhatsapp, validateRequest, appendRequestLink } from '../../src/data/requests.js';

const item = { name: 'Bajaj Pulsar NS200', kind: 'Bike', type: 'vehicle', location: 'Kurla West, Mumbai, Maharashtra', price: 950 };
const form = { name: 'Test User', phone: '1234567890', email: 'test12345@gmail.com', start: '2026-10-21', end: '2026-10-23', fulfilment: 'delivery', address: 'abcd' };

test('pickup and delivery append a direct link without changing a byte of the existing vehicle message', () => {
  for (const fulfilment of ['pickup', 'delivery']) {
    const booking = { ...savedBooking({ details: { ...form, fulfilment } }), _id: 'a'.repeat(24) };
    const original = vehicleBookingMessage({ booking });
    const shared = appendRequestLink(original, booking, 'https://rentsphere.example');
    assert.equal(shared, original + '\nRequest Link: https://rentsphere.example/request/' + booking._id);
    assert.equal(Buffer.compare(Buffer.from(shared.slice(0, original.length)), Buffer.from(original)), 0);
  }
});
function savedBooking({ vehicle = item, details = form, rental = 1900, charge = 445, estimated = false } = {}) {
  const delivery = details.fulfilment === 'delivery', fee = delivery ? charge : 0;
  return { _id: 'saved-request', requestType: 'vehicle', status: 'pending', contact: { name: details.name, phone: details.phone, email: details.email },
    startDate: details.start, endDate: details.end, fulfilment: details.fulfilment, totalPrice: rental + fee, deliveryCharge: fee,
    vehicleSnapshot: { name: vehicle.title || vehicle.name, pickupAddress: vehicle.location, pickupCoordinates: { lat: 19.07, lon: 72.87 } },
    ...(delivery ? { deliveryAddress: details.address, deliveryCoordinates: { lat: 19.1, lon: 72.9 }, deliveryQuote: { kind: estimated ? 'estimated' : 'calculated',
      ...(!estimated ? { distanceMeters: 12400 } : {}), pickupAddress: vehicle.location, pickupCoordinates: { lat: 19.07, lon: 72.87 },
      deliveryCoordinates: { lat: 19.1, lon: 72.9 }, rentalAmount: rental, deliveryCharge: fee, totalPrice: rental + fee } } : {}) };
}

test('genuine bike delivery message matches the requested format without internal request IDs or sample labels', () => {
  assert.equal(vehicleBookingMessage({ booking: savedBooking(), item: { price: 1 }, form: { name: 'Forged form value' }, estimatedTotal: 1 }),
    "🚗 *RentSphere – Vehicle Booking Request*\n\n*Vehicle:* Bajaj Pulsar NS200\n*Dates:* 2026-10-21 – 2026-10-23\n*Method:* Home Delivery\n\n*Customer Details:*\nName: Test User\nPhone: 1234567890\n\n*Pickup Address:* Kurla West, Mumbai, Maharashtra\n*Delivery Address:* abcd\n*Road Distance:* 12.40 km\n\n*Rental Amount:* ₹1,900\n*Delivery Charge:* ₹445\n*Total Amount:* ₹2,345\n\n*Customer Message:*\nI'd like to book this vehicle with home delivery. Please confirm availability and expected delivery time.\n\n*Note for Owner:*\nLog in to your RentSphere Owner Dashboard to Accept or Reject this request.");
});

test('car pickup message retains dynamic details, single-day pricing and free pickup without delivery fields', () => {
  const message = vehicleBookingMessage({ booking: savedBooking({ vehicle: { ...item, title: 'Different Car', location: 'Different Location' },
    details: { ...form, name: 'Another Customer', start: '2090-02-02', end: '2090-02-02', fulfilment: 'pickup' }, rental: 2800 }) });
  assert.match(message, /^🚗 \*RentSphere – Vehicle Booking Request\*/);
  assert.match(message, /\*Vehicle:\* Different Car/);
  assert.match(message, /Name: Another Customer/);
  assert.match(message, /\*Dates:\* 2090-02-02 – 2090-02-02/);
  assert.match(message, /\*Method:\* Self Pickup/);
  assert.match(message, /\*Pickup Address:\* Different Location/);
  assert.match(message, /\*Rental Amount:\* ₹2,800\n\*Delivery Charge:\* ₹0\n\*Total Amount:\* ₹2,800/);
  assert.match(message, /Please confirm availability, pickup time and required documents/);
  assert.doesNotMatch(message, /Delivery Address|Road Distance|Email:|test12345|Request ID|Sample|DEMO|internal-only/);
});

test('all sample and owner cars/bikes use the same standard message for pickup and delivery without disclaimers', () => {
  for (const kind of ['Car', 'Bike']) for (const fulfilment of ['pickup', 'delivery']) {
    const booking = savedBooking({ vehicle: { ...item, kind }, details: { ...form, fulfilment } });
    const message = vehicleBookingMessage({ booking: { ...booking, inventoryKind: 'sample', catalogKey: 'gpt-added-vehicle' } });
    assert.match(message, /^🚗 \*RentSphere – Vehicle Booking Request\*/);
    assert.equal(message, vehicleBookingMessage({ booking }));
    assert.doesNotMatch(message, /sample|demo|unverified|demonstration|Request ID:/i);
    assert.match(message, /\*Note for Owner:\*/);
  }
  // The shared property-message disclosure remains unchanged.
  assert.equal(sampleNotice({ inventoryKind: 'sample' }), 'DEMO / SAMPLE REQUEST — fictional inventory; no real rental or reservation.\n');
  assert.equal(sampleNotice(item), '');
});

test('property visit message uses actual values and requests location/time without owner interest instructions', () => {
  const message = previewVisitMessage({ title: 'Actual home title', location: 'Actual full address' }, { ...form, start: '2091-02-10' });
  for (const text of ['RentSphere — Property Visit Request', 'Property: Actual home title', 'Location: Actual full address', 'Name: ' + form.name, 'Phone: ' + form.phone, 'Email: ' + form.email, 'Preferred Visit Date: 2091-02-10', 'exact property location (preferably a Google Maps link)', 'a suitable visiting time', 'Thank you!']) assert.ok(message.includes(text), text);
  assert.doesNotMatch(message, /Not Interested|Interested|mark.*rented|Request ID/);
});

test('recipient routing preserves predefined contact and uses saved Indian mobile numbers for owner uploads', () => {
  for (const fixture of [{ id: 'RS101', phone: '9876543210' }, { _id: 'legacy', legacyId: 'RS101', phone: '9876543210', hostingDetailsVersion: 1 }, { _id: 'sample', catalogKey: 'mumbai-M01', phone: '9876543210' }]) assert.equal(whatsappRecipient(fixture), '919403570134');
  for (const phone of ['9876543210', '+91 98765 43210', '919876543210']) assert.equal(whatsappRecipient({ _id: 'owner-upload', host: 'owner', hostingDetailsVersion: 1, phone }), '919876543210');
  assert.throws(() => whatsappRecipient({ _id: 'owner-upload', host: 'owner', phone: 'owner@example.test' }), /valid owner contact/);
});

test('delivery/pickup variations work for cars and bikes using saved amounts, with honest distance-free fallback and zero pickup charges', () => {
  for (const kind of ['Car', 'Bike']) for (const fulfilment of ['pickup', 'delivery']) {
    const address = 'Building A, Floor 4\nFull road, Mumbai 400001';
    const message = vehicleBookingMessage({ booking: savedBooking({ vehicle: { ...item, kind, name: kind + ' fixture' }, details: { ...form, fulfilment, address }, rental: 2850, charge: 300, estimated: true }) });
    assert.ok(message.includes(kind + ' fixture'));
    if (fulfilment === 'delivery') { assert.ok(message.includes(address)); assert.match(message, /\*Rental Amount:\* ₹2,850\n\*Delivery Charge:\* ₹300\n\*Total Amount:\* ₹3,150/); assert.match(message, /Not calculated \(estimated delivery charge; subject to owner confirmation\)/); assert.doesNotMatch(message, /\d+\.\d+ km|pickup time|required documents/); }
    else { assert.match(message, /\*Total Amount:\* ₹2,850/); assert.doesNotMatch(message, /Delivery Address|Road Distance|expected delivery time/); }
  }
  assert.match(vehicleBookingMessage({ booking: savedBooking({ details: { ...form, fulfilment: 'pickup' }, rental: 0 }) }), /\*Total Amount:\* ₹0/);
});

test('message/recipient integration retains save-before-share order and existing pending request transport', async () => {
  for (const name of ['PropertyVisitModal', 'BookingModal']) {
    const source = await readFile(new URL(`../../src/components/${name}.jsx`, import.meta.url), 'utf8');
    if (name === 'PropertyVisitModal') assert.ok(source.indexOf('await saveRequest(') < source.indexOf('showWhatsapp(whatsappPopup,'));
    else {
      assert.ok(source.indexOf('await saveRequest(') < source.indexOf('setDone(true)'));
      assert.ok(source.indexOf('await saveRequest(') < source.indexOf('showWhatsapp(whatsappPopup,'));
      assert.match(source, /const openWhatsapp = \(\) => \{ if \(whatsappUrl\) window.open\(whatsappUrl, '_blank', 'noopener,noreferrer'\); \}/);
    }
    assert.ok(source.includes('whatsappRecipient(item)'));
    assert.ok(source.indexOf('whatsappRecipient(item)') < source.indexOf('await saveRequest('));
  }
});

test('vehicle submission saves once before redirecting the reserved tab; failed saves close it without opening WhatsApp', async () => {
  const source = await readFile(new URL('../../src/components/BookingModal.jsx', import.meta.url), 'utf8');
  const handler = source.match(/const submit = async e => \{[\s\S]*?\n\};/)?.[0];
  assert.ok(handler);
  const createSubmit = new Function('scope', `with (scope) { ${handler}; return submit; }`);
  const previousWindow = globalThis.window;
  try {
    for (const outcome of ['saved', 'failed', 'incomplete']) for (const fulfilment of ['pickup', 'delivery']) {
      const fail = outcome === 'failed', incomplete = outcome === 'incomplete';
      const opened = [], errors = [];
      const popup = { opener: {}, closed: false, location: { href: 'about:blank' }, close() { this.closed = true; } };
      globalThis.window = { open: (...args) => { opened.push(args); return popup; } };
      let resolveSave, rejectSave, saved = 0;
      const saving = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
      const vehicle = { ...item, _id: '507f1f77bcf86cd799439011', host: 'owner', phone: '9876543210', hostingDetailsVersion: 1 };
      const details = { ...form, start: '2091-01-01', end: '2091-01-03', fulfilment };
      const deliveryCharge = fulfilment === 'delivery' ? 445 : 0;
      const reviewedQuote = { quoteId: 'server-reviewed-reference', expiresAt: new Date(Date.now() + 600000).toISOString() };
      const persisted = { ...savedBooking({ vehicle: { ...vehicle, title: 'Saved vehicle name', location: 'Saved pickup address' }, details: { ...details, name: 'Saved Customer' }, rental: 1725, charge: 420 }), _id: 'a'.repeat(24) };
      const scope = { item: vehicle, form: details, user: { token: 'test-only' }, mode: 'vehicle', isVehicle: true, isDelivery: fulfilment === 'delivery',
        done: false, submissionLock: { current: false }, rentalDays: 2, rentalCost: 1900, deliveryCharge, estimatedTotal: 1900 + deliveryCharge,
        reviewedQuote, addressCoords: { lat: 19.1, lon: 72.9 }, quoteState: { invalidate() {} },
        isIsolatedPreview: () => false, isListingUnavailable: () => false, validateRequest, whatsappRecipient,
        reserveWhatsapp, showWhatsapp, vehicleBookingMessage, appendRequestLink: (message, request) => appendRequestLink(message, request, 'https://rentsphere.example'), formatPrice: String, isSampleRequest: () => false,
        setError: error => errors.push(error), setSubmitting() {}, setWhatsappUrl: url => { scope.whatsappUrl = url; },
        setDone: value => { scope.done = value; }, console: { error() {} },
        fetch: async () => ({ ok: true, json: async () => ({ available: true, bookedRanges: [] }) }),
        saveRequest: async body => { saved++; assert.equal(body.listingId, vehicle._id); assert.equal(body.fulfilment, fulfilment); assert.equal(body.deliveryQuoteId, fulfilment === 'delivery' ? reviewedQuote.quoteId : undefined); return saving; } };
      const submit = createSubmit(scope);
      const first = submit({ preventDefault() {} });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await submit({ preventDefault() {} });
      assert.equal(saved, 1); assert.equal(opened.length, 1);
      assert.equal(opened[0][0], 'about:blank'); assert.equal(popup.location.href, 'about:blank');
      assert.equal(scope.done, false);
      if (fail) rejectSave(new Error('Save failed'));
      else resolveSave(incomplete ? { _id: 'saved-request', status: 'pending' } : persisted);
      await first;
      if (fail || incomplete) {
        assert.equal(popup.closed, true); assert.equal(popup.location.href, 'about:blank');
        assert.equal(scope.done, incomplete);
        if (fail) assert.ok(errors.includes('Save failed'));
        else { assert.ok(errors.some(error => error.includes('Your booking was saved'))); await submit({ preventDefault() {} }); assert.equal(saved, 1); }
      } else {
        const url = new URL(popup.location.href);
        assert.equal(url.origin + url.pathname, 'https://wa.me/919876543210');
        assert.equal(url.searchParams.get('text'), vehicleBookingMessage({ booking: persisted }) + '\nRequest Link: https://rentsphere.example/request/' + persisted._id);
        assert.equal(scope.done, true); assert.equal(opened.length, 1);
        await submit({ preventDefault() {} }); assert.equal(saved, 1);
      }
    }
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});

test('saved details generate coordinate-only Google Maps links and preserve historical, estimated and missing-data cases', () => {
  const booking = savedBooking(), details = vehicleBookingDetails(booking);
  const route = new URL(details.routeUrl);
  assert.equal(route.origin, 'https://www.google.com'); assert.equal(route.pathname, '/maps/dir/');
  assert.equal(route.searchParams.get('origin'), '19.07,72.87'); assert.equal(route.searchParams.get('destination'), '19.1,72.9');
  assert.equal(route.searchParams.get('api'), '1'); assert.equal(route.searchParams.get('travelmode'), 'driving');
  assert.equal(vehicleBookingDetails({ ...booking, deliveryQuote: { ...booking.deliveryQuote, deliveryCoordinates: { lat: 91, lon: 72 } } }).routeUrl, null);
  assert.equal(vehicleBookingDetails({ ...booking, deliveryQuote: undefined, vehicleSnapshot: undefined }).routeUrl, null);
  const pickup = savedBooking({ details: { ...form, fulfilment: 'pickup' } });
  assert.equal(new URL(vehicleBookingDetails(pickup).locationUrl).searchParams.get('query'), '19.07,72.87');
  assert.equal(vehicleBookingDetails(pickup).routeUrl, null); assert.equal(pickupLocationUrl({ lat: '19', lon: 72 }), null);
  const missing = vehicleBookingDetails({ ...pickup, vehicleSnapshot: undefined, listing: { location: 'Legacy address', locationCoordinates: { lat: 19, lon: 72 } } });
  assert.equal(missing.pickupAddress, 'Legacy address'); assert.equal(missing.locationUrl, null);
  assert.equal(vehicleBookingDetails(savedBooking({ estimated: true })).distance, undefined);
  for (const invalid of [{ ...booking, vehicleSnapshot: undefined }, { ...booking, totalPrice: 1 },
    { ...booking, deliveryQuote: { ...booking.deliveryQuote, distanceMeters: undefined } }, { ...booking, contact: {} }]) assert.throws(() => vehicleBookingMessage({ booking: invalid }), /incomplete/);
});

test('owner instructions are appended to both vehicle fulfilment formats and property visits without owner interest instructions', () => {
  for (const fulfilment of ['pickup', 'delivery']) {
    const message = vehicleBookingMessage({ booking: savedBooking({ details: { ...form, fulfilment } }) });
    assert.match(message, /\*Note for Owner:\*\nLog in to your RentSphere Owner Dashboard to Accept or Reject this request\.$/);
  }
  const message = previewVisitMessage({ title: 'Actual property', location: 'Full address' }, form);
  assert.match(message, /Note for Property Owner:\nPlease log in to your RentSphere Owner Dashboard to Accept or Reject this visit request\./);
  assert.match(message, /Once accepted, kindly coordinate with the customer to confirm the exact property location and visiting time\.$/);
  assert.doesNotMatch(message, /Not Interested|Interested|mark.*rented/);
});

test('genuine owner form uploads override a stale sample flag without changing known catalog/sample identity', () => {
  for (const type of ['property', 'vehicle']) {
    const owned = { ...item, _id: '507f1f77bcf86cd799439011', host: 'actual-owner', hostingDetailsVersion: 1, type, phone: '9876543210', inventoryKind: 'sample' };
    const message = type === 'property' ? previewVisitMessage(owned, form) : vehicleBookingMessage({ booking: savedBooking({ vehicle: owned }) });
    assert.doesNotMatch(message, /Sample listing|\(Demo\)|demonstration request/);
    assert.equal(whatsappRecipient(owned), '919876543210');
    assert.throws(() => whatsappRecipient({ ...owned, phone: '' }), /valid owner contact/);
    const catalog = { ...owned, catalogKey: 'real-catalog-sample' };
    assert.equal(whatsappRecipient(catalog), '919403570134');
    if (type === 'property') assert.match(previewVisitMessage(catalog, form), /\(Demo\)/);
    else assert.doesNotMatch(vehicleBookingMessage({ booking: savedBooking({ vehicle: catalog }) }), /sample|demo|unverified/i);
  }
});

test('property interest card appears once after the gallery and before At a glance, with sample disclosure independent of staging context', async () => {
  const source = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.equal(source.match(/Did you like this property\?/g)?.length, 1);
  assert.ok(source.indexOf('className="gallery"') < source.indexOf('className="info-card rental-decision"'));
  assert.ok(source.indexOf('className="info-card rental-decision"') < source.indexOf('<h2>At a glance</h2>'));
  assert.match(source, /isProperty && \(!listingRented \|\| item.catalogContext === 'staging'\) && visitRequested && <article className="info-card rental-decision"/);
  assert.match(source, /\{isSample\(item\) && <span title="Fictional sample inventory; not a verified rental\."> · Sample · unverified<\/span>\}/);
  assert.doesNotMatch(source, /Demo \/ Sample inventory|Requests are demonstrations only\./);
});
