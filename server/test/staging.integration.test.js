import { configureDeliveryQuotes } from './helpers/deliveryQuoteFixture.js';
import { hostingFixture } from './helpers/hostingFixture.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createDecipheriv, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import express from 'express';
import { stagingConfig } from '../utils/stagingConfig.js';
import { readMigrationSnapshot, createDisposableMigrationTarget, inspectMigrationTarget, applyStagingMigration, connectApprovedStaging, migrationRolePlan, verifyEncryptedMigrationBackup } from '../utils/stagingMigration.js';
import { stagingListingPresentation, stagingInterestWorkflow } from '../utils/stagingParity.js';
import auth from '../routes/auth.js';
import listings from '../routes/listings.js';
import bookings from '../routes/bookings.js';
import admin from '../routes/admin.js';
import owner from '../routes/owner.js';
import { generateToken } from '../utils/tokens.js';
import { isIsolatedPreview, mergeCatalog } from '../../src/data/catalog.js';
import { inspectMigrationMedia } from '../utils/migrationMedia.js';
import { publicCatalogFilter, stagingSmokeListingIds } from '../utils/stagingPublicCatalog.js';

process.env.JWT_SECRET=randomBytes(48).toString('hex');
const EJSON=mongoose.mongo.BSON.EJSON;
let directory,local,source,fixture,server,origin;
const key=randomBytes(32).toString('base64');
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'rentsphere-staging-tests-'));
  const password=await bcrypt.hash('ChosenLocalFixturePassword!',10);
  const users=Array.from({length:14},(_,i)=>({_id:new mongoose.mongo.ObjectId(),name:'Fixture '+i,email:i===0?'admin@rentsphere.com':`fixture-${i}@example.test`,
    password,role:i<11?'admin':'user',ownerProfile:{status:'approved'}}));
  const listings=Array.from({length:48},(_,i)=>({_id:new mongoose.mongo.ObjectId(),title:'Shared test '+i,name:'Shared test '+i,
    type:i<24?'property':'vehicle',category:i<24?'Apartment':'SUV',location:'Mumbai',price:1000,host:users[1]._id,
    status:'available',image:'/catalog-placeholders/P01.svg',gallery:['/catalog-placeholders/P01.svg'],
    ...(i<9?{legacyId:'RS'+(i+1)}:{}),...(i===47?{archivedAt:new Date()}:{}),
    ...(i>=18?{inventoryKind:'sample',previewOnly:true,sampleDisclosure:'Fictional test inventory'}:{})}));
  const bookingRows=Array.from({length:16},(_,i)=>({_id:new mongoose.mongo.ObjectId(),user:users[2]._id,listing:listings[i%4===0?i:24+i]._id,
    requestType:i%4===0?'property_visit':'vehicle',requestId:randomUUID(),submissionKey:randomUUID(),status:'pending',
    startDate:new Date('2090-01-01Z'),endDate:new Date('2090-01-02Z'),totalPrice:i%4===0?0:1000,fulfilment:'pickup',deliveryCharge:0,
    ...(i===0?{propertyDecision:{kind:'not-interested',confirmedBy:users[2]._id,recordedAt:new Date()}}:{})}));
  fixture={version:1,secret:randomBytes(48).toString('hex'),collections:{users,listings,bookings:bookingRows,ownerdocuments:[]}};
  await writeFile(join(directory,'state.json'),EJSON.stringify(fixture));
  source=await readMigrationSnapshot(join(directory,'state.json'));
  local=await createDisposableMigrationTarget();
},{timeout:180000});
after(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));
  await mongoose.disconnect();await local?.close();
  // Only this newly minted OS temporary fixture directory is removed.
  if(directory)await rm(directory,{recursive:true,force:true});
});

test('staging configuration rejects production, wrong users/hosts and database overrides before connection',()=>{
  const base={RENTSPHERE_DATABASE_MODE:'staging',RENTSPHERE_STAGING_URI:'mongodb+srv://rentsphere_staging_user:fixture-only@rentsphere.4pxgci7.mongodb.net/rentsphere_staging?retryWrites=true&w=majority&authSource=admin'};
  assert.equal(stagingConfig(base).dbName,'rentsphere_staging');
  for(const uri of [base.RENTSPHERE_STAGING_URI.replace('/rentsphere_staging?','/rentsphere?'),base.RENTSPHERE_STAGING_URI.replace('staging_user:','production_user:'),base.RENTSPHERE_STAGING_URI.replace('4pxgci7','unapproved'),base.RENTSPHERE_STAGING_URI+'&dbName=rentsphere',base.RENTSPHERE_STAGING_URI.replace('mongodb+srv:','mongodb:'),'']) {
    assert.throws(()=>stagingConfig({...base,RENTSPHERE_STAGING_URI:uri}));
  }
  assert.throws(()=>stagingConfig({MONGODB_URI:base.RENTSPHERE_STAGING_URI}));
});

test('source validation preserves bcrypt hashes/identities and connection requires explicit fingerprint approval',async()=>{
  assert.deepEqual(source.counts,{users:14,listings:48,bookings:16,ownerdocuments:0});
  assert.equal(source.collections.users[0].password,fixture.collections.users[0].password);
  await assert.rejects(connectApprovedStaging({},'unapproved',source),/approval/);
  await assert.rejects(inspectMigrationTarget({db:{databaseName:'rentsphere'}},source),/Unapproved/);
  const invalid=structuredClone(fixture);invalid.sanitizedBackup=true;
  await writeFile(join(directory,'invalid.json'),EJSON.stringify(invalid));
  await assert.rejects(readMigrationSnapshot(join(directory,'invalid.json')),/original private/);
});

test('sole-admin mapping changes only ten role fields in detached copies and leaves the saved preview byte-for-byte unchanged',async()=>{
  const saved=await readFile(join(directory,'state.json'));
  assert.deepEqual(source.roleMapping.sourceRoles,{admin:11,user:3});
  assert.deepEqual(source.roleMapping.finalRoles,{admin:1,user:13});
  assert.equal(source.roleMapping.changedAccounts,10);
  assert.equal(source.roleMapping.adminAccountId,String(fixture.collections.users[0]._id));
  const recovered=EJSON.parse(EJSON.stringify(source.collections));
  for(let i=0;i<14;i++) {
    assert.equal(recovered.users[i].role,i===0?'admin':'user');
    assert.equal(recovered.users[i].password,fixture.collections.users[i].password);
    recovered.users[i].role=fixture.collections.users[i].role;
  }
  assert.deepEqual(recovered,fixture.collections);
  assert.deepEqual(source.originalCollections,fixture.collections);
  assert.deepEqual(await readFile(join(directory,'state.json')),saved);
  const isolated=await readMigrationSnapshot(join(directory,'state.json'));
  isolated.collections.users[1].ownerProfile.status='changed-only-in-copy';
  assert.equal(isolated.originalCollections.users[1].ownerProfile.status,'approved');
  assert.throws(()=>migrationRolePlan(isolated),/only the reviewed sole-admin/);
});

test('missing or ambiguous designated admin aborts; case normalization preserves the original email and identity',async()=>{
  for(const kind of ['missing','duplicate','case']) {
    const changed=EJSON.parse(EJSON.stringify(fixture));
    if(kind==='missing')changed.collections.users[0].email='not-the-admin@example.test';
    if(kind==='duplicate')changed.collections.users[1].email='ADMIN@RENTSPHERE.COM';
    if(kind==='case')changed.collections.users[0].email='Admin@RentSphere.com';
    const file=join(directory,kind+'.json');await writeFile(file,EJSON.stringify(changed));
    if(kind==='case'){
      const loaded=await readMigrationSnapshot(file);assert.equal(loaded.collections.users[0].email,'Admin@RentSphere.com');
      assert.equal(String(loaded.collections.users[0]._id),String(fixture.collections.users[0]._id));
      assert.equal(loaded.collections.users[0].role,'admin');
    }else await assert.rejects(readMigrationSnapshot(file),kind==='missing'?/exactly one/:/Email collisions/);
  }
});

test('approval digest binds role policy and mapped data; old pre-mapping digests and tampered copies cannot authorize writes',async()=>{
  const isolated=await createDisposableMigrationTarget();
  try{
    const plan=await inspectMigrationTarget(isolated.target,source);
    assert.equal(plan.planVersion,'staging-migration-sole-admin-v1');
    assert.deepEqual(plan.roleMapping.finalRoles,{admin:1,user:13});
    assert.equal(plan.mappedDataSha256,migrationRolePlan(source).mappedDataSha256);
    const legacy={...plan};for(const field of ['approvalDigest','planVersion','roleMapping','mappedDataSha256'])delete legacy[field];
    const sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])):value;
    const oldDigest=createHash('sha256').update(JSON.stringify(sort(EJSON.serialize(legacy,{relaxed:false})))).digest('hex');
    assert.notEqual(plan.approvalDigest,oldDigest);
    await assert.rejects(applyStagingMigration({target:isolated.target,source,approvedDigest:oldDigest,backupKey:key,backupDirectory:directory}),/approval/);
    for(const field of ['role','password']) {
      const tampered=await readMigrationSnapshot(join(directory,'state.json'));
      tampered.collections.users[1][field]=field==='role'?'admin':'changed-test-hash';
      await assert.rejects(inspectMigrationTarget(isolated.target,tampered),/only the reviewed sole-admin/);
    }
    assert.equal((await isolated.target.db.listCollections().toArray()).length,0);
  }finally{await isolated.close();}
});

test('unmapped existing staging admins are rejected without changing any account or password',async()=>{
  const isolated=await createDisposableMigrationTarget();
  try{
    await isolated.target.db.collection('users').insertMany(fixture.collections.users);
    const before=await isolated.target.db.collection('users').find({}).sort({_id:1}).toArray();
    await assert.rejects(inspectMigrationTarget(isolated.target,source),/outside the sole-admin policy/);
    assert.deepEqual(await isolated.target.db.collection('users').find({}).sort({_id:1}).toArray(),before);
  }finally{await isolated.close();}
});

test('read-only preflight performs no writes; approval/encryption gates precede all migration writes',async()=>{
  const plan=await inspectMigrationTarget(local.target,source);
  assert.deepEqual(plan.insertCounts,source.counts);
  assert.equal((await local.target.db.listCollections().toArray()).length,0);
  await assert.rejects(applyStagingMigration({target:local.target,source,approvedDigest:'wrong',backupKey:key,backupDirectory:directory}),/approval/);
  await assert.rejects(applyStagingMigration({target:local.target,source,approvedDigest:plan.approvalDigest,backupDirectory:directory}),/encryption key/);
  assert.equal((await local.target.db.listCollections().toArray()).length,0);
});

test('insert-only transaction preserves all raw records/hashes, creates encrypted backup and reruns without duplicates',async()=>{
  const plan=await inspectMigrationTarget(local.target,source);
  const result=await applyStagingMigration({target:local.target,source,approvedDigest:plan.approvalDigest,backupKey:key,backupDirectory:directory});
  assert.deepEqual(result.inserted,source.counts);assert.equal(result.verified,true);
  assert.equal(result.backupVerified,true);
  const encrypted=await readFile(result.backup);
  assert.ok(!encrypted.includes(Buffer.from(fixture.collections.users[0].password)));
  const decipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'base64'),encrypted.subarray(5,17));decipher.setAuthTag(encrypted.subarray(17,33));
  const saved=EJSON.parse(Buffer.concat([decipher.update(encrypted.subarray(33)),decipher.final()]).toString());
  assert.deepEqual(saved.collections,{});
  assert.equal(saved.sourcePreview.secret,fixture.secret);
  assert.deepEqual(saved.sourcePreview.collections,fixture.collections);
  await assert.rejects(verifyEncryptedMigrationBackup(result.backup,randomBytes(32),EJSON.stringify(saved)),/backup verification failed/);
  await assert.rejects(verifyEncryptedMigrationBackup(result.backup,Buffer.from(key,'base64'),'incorrect expected contents'),/backup verification failed/);
  const corrupted=Buffer.from(encrypted);corrupted[20]^=1;
  const corruptFile=join(directory,'corrupted-backup.enc');await writeFile(corruptFile,corrupted);
  await assert.rejects(verifyEncryptedMigrationBackup(corruptFile,Buffer.from(key,'base64'),EJSON.stringify(saved)),/backup verification failed/);
  for(const name of ['users','listings','bookings']) {
    const actual=await local.target.db.collection(name).find({}).sort({_id:1}).toArray();
    const expected=[...source.collections[name]].sort((a,b)=>String(a._id).localeCompare(String(b._id)));
    assert.deepEqual(actual,expected);
  }
  const repeat=await inspectMigrationTarget(local.target,source);
  const again=await applyStagingMigration({target:local.target,source,approvedDigest:repeat.approvalDigest,backupKey:key,backupDirectory:directory});
  assert.ok(Object.values(again.inserted).every(n=>n===0));assert.deepEqual(again.skipped,source.counts);
});

test('changed target records and canonical-email collisions abort without overwriting staging data',async()=>{
  const id=fixture.collections.users[0]._id;
  await local.target.db.collection('users').updateOne({_id:id},{$set:{name:'Changed in staging'}});
  await assert.rejects(inspectMigrationTarget(local.target,source),/differs/);
  assert.equal((await local.target.db.collection('users').findOne({_id:id})).name,'Changed in staging');
  await local.target.db.collection('users').replaceOne({_id:id},fixture.collections.users[0]);
  const collision={...fixture.collections.users[3],role:'user',_id:new mongoose.mongo.ObjectId(),email:fixture.collections.users[3].email.toUpperCase()};
  // A source ID is present already, so test the collision in a fresh local target.
  const isolated=await createDisposableMigrationTarget();
  try {await isolated.target.db.collection('users').insertOne(collision);await assert.rejects(inspectMigrationTarget(isolated.target,source),/collision/);assert.equal(await isolated.target.db.collection('users').countDocuments(),1);}
  finally{await isolated.close();}
});

test('failed transactional inserts roll back users/listings/bookings and leave an encrypted pre-write backup',async t=>{
  const isolated=await createDisposableMigrationTarget();
  const original=mongoose.mongo.Collection.prototype.insertMany;
  try {
    const plan=await inspectMigrationTarget(isolated.target,source);
    t.mock.method(mongoose.mongo.Collection.prototype,'insertMany',function(rows,options){
      if(this.collectionName==='bookings')throw new Error('Disposable test write failure');
      return original.call(this,rows,options);
    });
    await assert.rejects(applyStagingMigration({target:isolated.target,source,approvedDigest:plan.approvalDigest,backupKey:key,backupDirectory:directory}),/test write failure/);
    for(const name of ['users','listings','bookings'])assert.equal(await isolated.target.db.collection(name).countDocuments(),0);
  }finally{t.mock.restoreAll();await isolated.close();}
});

test('media preflight rejects missing uploads and fingerprints all preserved files without modifying them',async()=>{
  const root=join(directory,'media-fixture');
  const {mkdir}=await import('node:fs/promises');
  await mkdir(join(root,'uploads'),{recursive:true});await writeFile(join(root,'uploads','fixture.jpg'),'fixture-media-bytes');
  const mediaSource={collections:{users:[],listings:[{image:'/uploads/fixture.jpg',gallery:[]}]}};
  const result=await inspectMigrationMedia(mediaSource,root,1);
  assert.equal(result.files,1);assert.equal(result.references.uploads,1);
  assert.equal((await readFile(join(root,'uploads','fixture.jpg'))).toString(),'fixture-media-bytes');
  mediaSource.collections.listings[0].image='/uploads/missing.jpg';
  await assert.rejects(inspectMigrationMedia(mediaSource,root,1),/missing/);
});

test('normal staging routers preserve all logins, enforce sole-admin access and retain catalog/history/decisions after reconnect',async()=>{
  await mongoose.connect(local.uri,{dbName:'rentsphere_staging'});
  const app=express(); configureDeliveryQuotes(app);app.use(express.json());app.use('/api/auth',auth);
  app.use('/api/listings',stagingListingPresentation,listings);app.use('/api/bookings',bookings);
  app.use('/api/admin',admin);app.use('/api/owner',owner);app.use('/api/preview',stagingInterestWorkflow);
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});origin='http://127.0.0.1:'+server.address().port;
  const request=async(path,{user,body,method='GET'}={})=>{
    const res=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+generateToken(user._id)}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return{status:res.status,data:await res.json()};
  };
  const [administrator,host,customer]=fixture.collections.users;
  const login=await request('/api/auth/login',{method:'POST',body:{email:administrator.email,password:'ChosenLocalFixturePassword!'}});
  assert.equal(login.status,200);assert.equal(login.data._id,String(administrator._id));assert.equal(login.data.role,'admin');
  for(const account of fixture.collections.users) {
    const result=await request('/api/auth/login',{method:'POST',body:{email:account.email,password:'ChosenLocalFixturePassword!'}});
    assert.equal(result.status,200);assert.equal(result.data._id,String(account._id));
    assert.equal(result.data.role,account.email==='admin@rentsphere.com'?'admin':'user');
    if(account.email!=='admin@rentsphere.com')assert.equal((await request('/api/admin/stats',{user:account})).status,403);
  }
  assert.equal((await request('/api/admin/stats',{user:administrator})).status,200);
  assert.equal((await request('/api/admin/stats',{user:customer})).status,403);
  assert.equal((await request('/api/owner/me',{user:host})).status,200);
  assert.equal((await request('/api/listings/mine',{user:host})).data.length,47);
  const catalog=await request('/api/listings');assert.equal(catalog.data.length,47);
  assert.ok(catalog.data.every(row=>isIsolatedPreview(row)&&row.catalogContext==='staging'));
  assert.equal(mergeCatalog(catalog.data,[{id:'archived-fallback-must-not-reappear'}]).length,47);
  const alias=await request('/api/listings/RS1');assert.equal(alias.data._id,String(fixture.collections.listings[0]._id));
  const visit=fixture.collections.bookings.find(row=>row.requestType==='property_visit'&&!row.propertyDecision);
  assert.equal((await request('/api/bookings/'+visit._id+'/confirm',{user:administrator,method:'PUT'})).status,200);
  const decision=await request('/api/preview/property-visits/'+visit._id+'/decision',{user:customer,method:'POST',body:{decision:'interested',confirmedInApp:true}});
  assert.equal(decision.status,200,JSON.stringify(decision.data));assert.equal(decision.data.propertyStatus,'available');
  assert.equal(decision.data.propertyAvailable,false);
  await mongoose.disconnect();await mongoose.connect(local.uri,{dbName:'rentsphere_staging'});
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email:administrator.email,password:'ChosenLocalFixturePassword!'}})).status,200);
  assert.equal((await request('/api/listings/'+visit.listing)).data.status,'available');
  assert.equal((await request('/api/listings/'+visit.listing)).data.available,false);
  const history=await request('/api/bookings/mybookings',{user:customer});assert.equal(history.data.length,16);
  assert.ok(history.data.every(row=>row.listing));
  const filtered=await request('/api/listings?type=vehicle&category=SUV&q=Shared');assert.ok(filtered.data.every(row=>row.type==='vehicle'&&row.category==='SUV'));
  const registration=await request('/api/auth/register',{method:'POST',body:{name:'New staging fixture',email:'new-staging@example.test',password:'ChosenNewStagingPassword!',role:'admin'}});
  assert.equal(registration.status,201);assert.equal(registration.data.role,'user');
  assert.equal((await request('/api/auth/register',{method:'POST',body:{name:'Duplicate',email:'NEW-STAGING@example.test',password:'ChosenNewStagingPassword!'}})).status,400);
  const listingInput={...hostingFixture(),type:'property',title:'New persisted listing',location:'Mumbai',price:1200};
  assert.equal((await request('/api/listings',{user:host,method:'POST',body:listingInput})).status,403);
  const created=await request('/api/listings',{user:administrator,method:'POST',body:listingInput});
  assert.equal(created.status,201,JSON.stringify(created.data));
  const newVisit=await request('/api/bookings/visits',{user:customer,method:'POST',body:{listingId:created.data._id,startDate:'2091-01-01'}});
  assert.equal(newVisit.status,201);
  const newBooking=await request('/api/bookings',{user:customer,method:'POST',body:{listingId:String(fixture.collections.listings[40]._id),startDate:'2091-01-01',endDate:'2091-01-02'}});
  assert.equal(newBooking.status,201);
  await mongoose.disconnect();await mongoose.connect(local.uri,{dbName:'rentsphere_staging'});
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'new-staging@example.test',password:'ChosenNewStagingPassword!'}})).status,200);
  assert.equal((await request('/api/listings/'+created.data._id)).data.title,'New persisted listing');
  const afterRestart=await request('/api/bookings/mybookings',{user:customer});
  assert.equal(afterRestart.data.length,18);
  for(const id of [newVisit.data._id,newBooking.data._id])assert.ok(afterRestart.data.some(row=>row._id===id));
});

test('only recorded staging smoke listing IDs are excluded from public browsing/search; records and admin counts remain intact', async () => {
  assert.deepEqual(publicCatalogFilter('disposable-preview'), {});
  assert.deepEqual(publicCatalogFilter('rentsphere_staging'), { _id: { $nin: [...stagingSmokeListingIds] } });
  const inserted = [
    ...stagingSmokeListingIds.map((id, i) => ({ ...fixture.collections.listings[i ? 25 : 1],
      _id: new mongoose.mongo.ObjectId(id), title: 'Phase2 Smoke recorded fixture', name: 'Phase2 Smoke recorded fixture',
      host: fixture.collections.users[0]._id })),
    { ...fixture.collections.listings[1], _id: new mongoose.mongo.ObjectId(),
      title: 'Phase2 Smoke genuine similarly named listing', name: 'Phase2 Smoke genuine similarly named listing', host: fixture.collections.users[0]._id },
  ];
  await mongoose.connection.db.collection('listings').insertMany(inserted);
  const before = await mongoose.connection.db.collection('listings').find({}).sort({ _id: 1 }).toArray();
  for (const query of ['', '?q=Phase2%20Smoke', '?type=property', '?type=vehicle', '?type=property&category=Apartment&q=Phase2%20Smoke', '?type=vehicle&category=SUV&q=Phase2%20Smoke']) {
    const response = await fetch(origin + '/api/listings' + query);
    assert.equal(response.status, 200);
    const rows = await response.json();
    assert.ok(rows.every(row => !stagingSmokeListingIds.includes(row._id)));
    if (!query.includes('type=vehicle')) assert.ok(rows.some(row => row._id === String(inserted[2]._id)));
  }
  const headers = { Authorization: 'Bearer ' + generateToken(fixture.collections.users[0]._id) };
  const adminRows = await (await fetch(origin + '/api/admin/listings', { headers })).json();
  for (const id of stagingSmokeListingIds) assert.ok(adminRows.some(row => row._id === id));
  const stats = await (await fetch(origin + '/api/admin/stats', { headers })).json();
  assert.equal(stats.totalProducts, before.filter(row => !row.archivedAt).length);
  assert.deepEqual(await mongoose.connection.db.collection('listings').find({}).sort({ _id: 1 }).toArray(), before);
});
