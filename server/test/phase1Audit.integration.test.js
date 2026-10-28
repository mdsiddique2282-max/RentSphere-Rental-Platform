import { configureDeliveryQuotes } from './helpers/deliveryQuoteFixture.js';
import { hostingFixture } from './helpers/hostingFixture.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import User from '../models/User.js';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';
import authRoutes from '../routes/auth.js';
import ownerRoutes from '../routes/owner.js';
import adminRoutes from '../routes/admin.js';
import listingRoutes from '../routes/listings.js';
import bookingRoutes from '../routes/bookings.js';
import { generateToken } from '../utils/tokens.js';

// Never import env.js/server.js, read .env or use a configured database URI.
process.env.JWT_SECRET = randomBytes(48).toString('hex');
let mongo, server, origin, admin, owner, customer, outsider;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: join(tmpdir(), 'rentsphere-test-mongodb') },
    replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(mongo.getUri(), { dbName: `phase1_audit_${randomUUID().replaceAll('-', '')}` });
  await Promise.all([User.init(), Listing.init(), Booking.init()]);
  [admin, owner, customer, outsider] = await Promise.all(['admin', 'owner', 'user', 'owner'].map(role => User.create({
    name: 'Audit fixture', email: `${randomUUID()}@example.test`, password: 'test-password', role,
    ownerProfile: { status: 'approved', listingIntent: 'both' },
  })));
  const app = express(); configureDeliveryQuotes(app); app.use(express.json());
  for (const [path, router] of Object.entries({ auth: authRoutes, owner: ownerRoutes,
    admin: adminRoutes, listings: listingRoutes, bookings: bookingRoutes })) app.use(`/api/${path}`, router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 180000 });
after(async () => {
  if(server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect(); if(mongo) await mongo.stop();
});
async function request(path, { actor, method = 'GET', body } = {}) {
  const res = await fetch(origin + '/api' + path, { method,
    headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${generateToken(actor._id)}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() };
}
const makeListing = (values = {}) => Listing.create({ type: 'property', title: 'Audit Shared',
  location: 'Mumbai', price: 1000, host: owner._id, ...values });
const dates = { startDate: '2090-01-01', endDate: '2090-01-02' };
const visit = async item => {
  const res = await request('/bookings/visits', { actor: customer, method: 'POST', body: { listingId: String(item._id), ...dates } });
  assert.equal(res.status, 201, JSON.stringify(res.data)); return res.data;
};

test('A01 admin reads are read-only, return exact empty totals, and report query failures', async t => {
  const beforeUsers = await User.find().lean();
  for(const endpoint of ['stats', 'users', 'listings', 'owners', 'bookings']) {
    const result = await request('/admin/' + endpoint, { actor: admin });
    assert.equal(result.status, 200);
    if(endpoint === 'stats') {
      assert.equal(result.data.totalUsers, beforeUsers.length);
      for(const key of ['totalProducts','totalVehicles','totalRooms','totalBookings','totalCategories','userUploadedProductsCount']) assert.equal(result.data[key],0);
      assert.deepEqual(result.data.recentProducts, []);
    }
    if(endpoint === 'listings') assert.deepEqual(result.data, []);
  }
  assert.equal(await Listing.countDocuments(),0);
  assert.deepEqual(await User.find().lean(), beforeUsers);
  for(const endpoint of ['stats','users','listings']) {
    t.mock.method(Listing, endpoint === 'listings' ? 'find' : 'countDocuments', () => { throw new Error('Fixture read failure'); });
    try { assert.equal((await request('/admin/'+endpoint,{actor:admin})).status,503); }
    finally { t.mock.restoreAll(); }
  }
});

test('A02 owner registration/login normalize casing and both registration routes reject duplicates', async () => {
  const email = `MixedOwner-${randomUUID()}@Example.test`;
  const registered = await request('/owner/register', { method:'POST',body:{name:'Owner',email:' '+email+' ',password:'owner-password',phone:'9876543210'} });
  assert.equal(registered.status,201); assert.equal(registered.data.email,email.toLowerCase());
  for(const casing of [email,email.toLowerCase(),email.toUpperCase()]) {
    const login = await request('/auth/login',{method:'POST',body:{email:casing,password:'owner-password'}});
    assert.equal(login.status,200); assert.equal(login.data._id,registered.data._id); assert.equal(login.data.role,'owner');
  }
  for(const route of ['/owner/register','/auth/register']) assert.equal((await request(route,{method:'POST',body:{name:'Duplicate',email,password:'another-password'}})).status,400);
});

test('A02 legacy case collisions preserve IDs, hashes and roles and never guess an ambiguous identity', async () => {
  const suffix = randomUUID(); const email = `Legacy-${suffix}@Example.test`;
  const first = await User.create({name:'Legacy owner',email,password:'same-password',role:'owner'});
  const second = await User.create({name:'Legacy user',email:email.toLowerCase(),password:'same-password'});
  const before = await User.find({_id:{$in:[first._id,second._id]}}).lean();
  for(const user of [first,second]) {
    const result = await request('/auth/login',{method:'POST',body:{email:user.email,password:'same-password'}});
    assert.equal(result.status,200); assert.equal(result.data._id,String(user._id)); assert.equal(result.data.role,user.role);
  }
  assert.equal((await request('/auth/login',{method:'POST',body:{email:email.toUpperCase(),password:'same-password'}})).status,409);
  assert.deepEqual(await User.find({_id:{$in:[first._id,second._id]}}).lean(),before);
  const lone = await User.create({name:'Lone',email:`Lone-${suffix}@Example.test`,password:'x',role:'admin'});
  const login=await request('/auth/login',{method:'POST',body:{email:lone.email.toLowerCase(),password:'x'}});
  assert.equal(login.status,200); assert.equal(login.data._id,String(lone._id)); assert.equal(login.data.role,'admin');
});

test('A03 search, category/kind and type intersect; query text is literal and errors are real', async t => {
  const suv=await makeListing({type:'vehicle',category:'SUV',kind:'Car'});
  await makeListing({type:'vehicle',category:'Sedan',kind:'Car'});
  await makeListing({category:'SUV'});
  const result=await request('/listings?type=vehicle&category=SUV&q=Audit%20Shared');
  assert.equal(result.status,200);assert.deepEqual(result.data.map(row=>row._id),[String(suv._id)]);
  assert.equal((await request('/listings?type=vehicle&category=Car&q=Audit')).data.length,2);
  assert.equal((await request('/listings?q=%5B')).data.length,0);
  t.mock.method(Listing,'find',()=>{throw new Error('Fixture failure');});
  try{assert.equal((await request('/listings')).status,503);}finally{t.mock.restoreAll();}
});

test('A04 normal visits and generic property requests reject rented/unavailable/draft properties without writes', async () => {
  for(const values of [{status:'rented'},{availability:'Unavailable'},{availability:'Currently Rented'},{publicationState:'draft'}]) {
    const item=await makeListing(values);
    for(const route of ['/bookings','/bookings/visits']) {
      const result=await request(route,{actor:customer,method:'POST',body:{listingId:String(item._id),...dates}});
      assert.equal(result.status,values.publicationState ? 404 : 409);
    }
    assert.equal(await Booking.countDocuments({listing:item._id}),0);
  }
});

test('A05 visit owner/admin accept/reject APIs enforce scope, terminal states and preserve property availability', async () => {
  const item=await makeListing(); const pending=await visit(item);
  for(const actor of [customer,outsider]) for(const action of ['confirm','reject']) {
    assert.equal((await request(`/bookings/${pending._id}/${action}`,{actor,method:'PUT'})).status,403);
  }
  let result=await request(`/bookings/${pending._id}/confirm`,{actor:owner,method:'PUT'});
  assert.equal(result.status,200); assert.equal(result.data.status,'confirmed');
  assert.equal((await request(`/bookings/${pending._id}/confirm`,{actor:admin,method:'PUT'})).status,200);
  assert.equal((await request(`/bookings/${pending._id}/reject`,{actor:owner,method:'PUT'})).status,409);
  assert.equal((await Listing.findById(item._id)).status,'available');
  const another=await visit(await makeListing());
  result=await request(`/bookings/${another._id}/reject`,{actor:admin,method:'PUT'});
  assert.equal(result.status,200);assert.equal(result.data.status,'rejected');
  assert.equal((await request(`/bookings/${another._id}/confirm`,{actor:owner,method:'PUT'})).status,409);
  const cancelled=await visit(await makeListing());
  assert.equal((await request(`/bookings/${cancelled._id}/cancel`,{actor:customer,method:'PUT'})).status,200);
  assert.equal((await request(`/bookings/${cancelled._id}/confirm`,{actor:owner,method:'PUT'})).status,409);
  const inbox=await request('/bookings/owner/visits',{actor:owner});
  assert.equal(inbox.status,200);assert.ok(inbox.data.some(row=>row._id===pending._id));
  assert.deepEqual((await request('/bookings/owner/visits',{actor:outsider})).data,[]);
  assert.equal((await request('/bookings/owner/visits',{actor:customer})).status,403);
});

test('A05 concurrent accept/reject has one winner and confirmation of newly rented property fails', async () => {
  const item=await makeListing();const pending=await visit(item);
  const results=await Promise.all(['confirm','reject'].map(action=>request(`/bookings/${pending._id}/${action}`,{actor:owner,method:'PUT'})));
  assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);
  const next=await visit(await makeListing());
  await Listing.updateOne({_id:next.listing},{$set:{status:'rented'}});
  assert.equal((await request(`/bookings/${next._id}/confirm`,{actor:owner,method:'PUT'})).status,409);
  assert.equal((await Booking.findById(next._id)).status,'pending');
});

test('A06 create/update/schema reject negative and invalid prices and retain valid zero pricing', async () => {
  const count=await Listing.countDocuments();
  for(const price of [-1,'-1','NaN','Infinity','',null,true,{},[]]) {
    assert.equal((await request('/listings',{actor:owner,method:'POST',body:{type:'property',location:'Mumbai',price}})).status,400);
  }
  assert.equal(await Listing.countDocuments(),count);
  const item=await makeListing();
  for(const price of [-1,null,'NaN','',true]) assert.equal((await request('/listings/'+item._id,{actor:owner,method:'PUT',body:{price}})).status,400);
  assert.equal((await Listing.findById(item._id)).price,1000);
  for(const price of [-1,Infinity,NaN]) await assert.rejects(makeListing({price}));
  assert.equal((await request('/listings',{actor:owner,method:'POST',body:{...hostingFixture(),type:'property',location:'Mumbai',price:0}})).status,201);
});

test('A07 owner/admin removal archives referenced listings, preserving bookings, IDs and images', async () => {
  for(const route of ['/listings/','/admin/listings/']) {
    const item=await makeListing({image:'/catalog-media/history.jpg',gallery:['/catalog-media/history.jpg']});
    const pending=await visit(item);const before=await Booking.findById(pending._id).lean();
    assert.equal((await request(route+item._id,{actor:route.includes('admin')?admin:owner,method:'DELETE'})).status,200);
    const retained=await Listing.findById(item._id);
    assert.ok(retained.archivedAt);assert.equal(retained.image,item.image);assert.deepEqual(retained.gallery,item.gallery);
    assert.deepEqual(await Booking.findById(pending._id).lean(),before);
    const history=await request('/bookings/mybookings',{actor:customer});
    assert.equal(history.data.find(row=>row._id===pending._id).listing._id,String(item._id));
    for(const path of ['/listings','/listings/mine','/admin/listings']) {
      assert.ok(!(await request(path,{actor:path.includes('admin')?admin:owner})).data.some(row=>row._id===String(item._id)));
    }
    assert.equal((await request('/listings/'+item._id)).status,404);
    assert.equal((await request('/bookings/visits',{actor:customer,method:'POST',body:{listingId:String(item._id),...dates}})).status,404);
  }
  const item=await makeListing();
  assert.equal((await request('/listings/'+item._id,{actor:owner,method:'DELETE'})).status,200);
  assert.equal(await Listing.findById(item._id),null);
  assert.equal((await request('/admin/users/'+customer._id,{actor:admin,method:'DELETE'})).status,409);
  assert.ok(await User.findById(customer._id));
  assert.equal((await request('/admin/users/'+owner._id,{actor:admin,method:'DELETE'})).status,409);
  assert.ok(await User.findById(owner._id));
});

test('A04/A07 concurrent visit creation and removal never leave dangling booking references', async () => {
  for (let i=0;i<4;i++) {
    const item=await makeListing();
    const [created,removed]=await Promise.all([
      request('/bookings/visits',{actor:customer,method:'POST',body:{listingId:String(item._id),...dates}}),
      request('/listings/'+item._id,{actor:owner,method:'DELETE'}),
    ]);
    assert.ok([201,404,409].includes(created.status),JSON.stringify(created));
    assert.ok([200,409].includes(removed.status),JSON.stringify(removed));
    if(created.status===201) {
      const stored=await Booking.findById(created.data._id).populate('listing');
      assert.ok(stored.listing,'A successful request always retains its listing');
    }
  }
});

test('A08 both registration APIs validate malformed email, short/oversized passwords and non-string input', async () => {
  const count=await User.countDocuments();
  for(const route of ['/auth/register','/owner/register']) for(const values of [
    {email:'not-an-email'},{email:'a@@example.test'},{email:{ $ne:null }},{password:'x'},
    {password:'a'.repeat(73)},{password:'😀'.repeat(19)},{password:{}},{password:'      '},{name:' '},
  ]) {
    const result=await request(route,{method:'POST',body:{name:'Validation',email:`${randomUUID()}@example.test`,password:'valid-password',...values}});
    assert.equal(result.status,400,JSON.stringify(result));
  }
  assert.equal(await User.countDocuments(),count);
});
