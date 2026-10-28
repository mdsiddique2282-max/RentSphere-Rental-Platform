import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCoordinates, coordinateValue, reverseAddress } from '../../src/data/coordinates.js';
import { hostingValues, validateHosting } from '../../src/data/hosting.js';
import { hostingFixture } from './helpers/hostingFixture.js';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';

test('shared coordinates validate exact numeric pairs without coercion or invented legacy pins', async () => {
  for (const pin of [{ lat: 0, lon: 0 }, { lat: -90, lon: 180 }, { lat: 19.123456789, lon: 72.123456789 }]) {
    assert.deepEqual(coordinateValue(pin), pin); assert.equal(isCoordinates(pin), true);
    assert.deepEqual(hostingValues({ ...hostingFixture('vehicle'), locationCoordinates: pin }).locationCoordinates, pin);
    assert.deepEqual(validateHosting({ ...hostingFixture('vehicle'), locationCoordinates: pin }).locationCoordinates, pin);
  }
  for (const invalid of [null, false, [], {}, { lat: '19', lon: 72 }, { lat: Infinity, lon: 72 }, { lat: 19, lon: NaN }, { lat: 90.1, lon: 72 }, { lat: 19, lon: -180.1 }, { lat: 19, lon: 72, fake: true }]) {
    assert.throws(() => coordinateValue(invalid), /Coordinates/);
    if (invalid !== null) assert.throws(() => validateHosting({ ...hostingFixture('vehicle'), locationCoordinates: invalid }), /Coordinates/);
  }
  assert.equal(coordinateValue(undefined), undefined); assert.equal(coordinateValue(null, true), null);
  assert.equal(hostingValues(hostingFixture('vehicle', { legacy: true })).locationCoordinates, undefined);
  assert.equal(validateHosting(hostingFixture('property', { legacy: true })).locationCoordinates, undefined);
  const listing = new Listing({ ...hostingFixture('vehicle'), host: '507f1f77bcf86cd799439011', locationCoordinates: { lat: '19', lon: 72 } });
  await assert.rejects(listing.validate(), /locationCoordinates/);
  const booking = new Booking({ user: '507f1f77bcf86cd799439011', listing: '507f1f77bcf86cd799439011', startDate: new Date(), endDate: new Date(), totalPrice: 300, deliveryCoordinates: { lat: 91, lon: 72 } });
  await assert.rejects(booking.validate(), /deliveryCoordinates/);
});

test('reverse geocoding returns only a readable address, preserving the exact selected pin and sanitizing network errors', async () => {
  const pin = { lat: 19.123456789, lon: 72.987654321 }, original = { ...pin };
  const address = await reverseAddress(pin, { key: 'mock-only', send: async url => {
    const parsed = new URL(url); assert.equal(parsed.searchParams.get('lat'), String(pin.lat)); assert.equal(parsed.searchParams.get('lon'), String(pin.lon));
    return { ok: true, json: async () => ({ features: [{ properties: { formatted: 'Reviewed map address', lat: 19, lon: 72 } }] }) };
  } });
  assert.equal(address, 'Reviewed map address'); assert.deepEqual(pin, original);
  for (const mode of ['network', 'http', 'empty']) await assert.rejects(reverseAddress(pin, { key: 'mock-only', send: async () => {
    if (mode === 'network') throw new Error('https://api.example.test/?apiKey=private-test-value');
    return { ok: mode !== 'http', json: async () => ({ features: [] }) };
  } }), error => { assert.match(error.message, /selected pin is unchanged/); assert.doesNotMatch(error.message, /private-test-value|apiKey/); return true; });
  await assert.rejects(reverseAddress(pin, { key: '' }), /not configured/);
  const aborted = Object.assign(new Error('Cancelled'), { name: 'AbortError' });
  await assert.rejects(reverseAddress(pin, { key: 'mock-only', send: async () => { throw aborted; } }), error => error === aborted);
});


test('map search validates returned pins, preserves address precision and never exposes provider errors', async () => {
  const { searchAddresses } = await import('../../src/data/coordinates.js');
  const rows=await searchAddresses('Test Mumbai address',{key:'mock-only',send:async url=>{
    const parsed=new URL(url);assert.equal(parsed.searchParams.get('text'),'Test Mumbai address');assert.equal(parsed.searchParams.get('filter'),'countrycode:in');
    return {ok:true,json:async()=>({features:[{properties:{formatted:'Reviewed address',lat:18.957526,lon:72.841516}},{properties:{formatted:'Invalid pin',lat:999,lon:72}}]})};
  }});
  assert.deepEqual(rows,[{formatted:'Reviewed address',lat:18.957526,lon:72.841516}]);
  await assert.rejects(searchAddresses('Mumbai',{key:'mock-only',send:async()=>{throw new Error('private-provider-value');}}),error=>/search is unavailable/.test(error.message)&&!error.message.includes('private-provider-value'));
});

test('frontend hosting preflight rejects invalid or outside pins and failures, but never blocks unchanged legacy locations', async () => {
  const { hostingLocationChanged,validateHostingLocation }=await import('../../src/data/hosting.js');
  const pin={lat:18.957526,lon:72.841516},existing={location:'Saved address',locationCoordinates:pin};
  let calls=0;const send=async(path,options)=>{calls++;assert.equal(path,'/api/listings/validate-location');assert.equal(options.headers.Authorization,'Bearer mock-only');assert.deepEqual(JSON.parse(options.body),{locationCoordinates:pin});return new Response(JSON.stringify({valid:true}));};
  assert.equal(hostingLocationChanged({...existing,price:5},existing),false);
  await validateHostingLocation({...existing,price:5},existing,'mock-only',send);assert.equal(calls,0);
  await validateHostingLocation({location:'Legacy address'}, {location:'Legacy address'},'mock-only',send);assert.equal(calls,0);
  await validateHostingLocation(existing,null,'mock-only',send);assert.equal(calls,1);
  for(const locationCoordinates of [undefined,null,{lat:'19',lon:72}]) await assert.rejects(validateHostingLocation({location:'Changed address',locationCoordinates},existing,'mock-only',send));
  const outside='This location is outside the RentSphere service area. Please choose a supported location on the map.';
  await assert.rejects(validateHostingLocation(existing,null,'mock-only',async()=>new Response(JSON.stringify({message:outside}),{status:422})),error=>error.message===outside);
  await assert.rejects(validateHostingLocation(existing,null,'mock-only',async()=>new Response('<html>')),/Unable to validate/);
});
