// End-to-end authentication checks against a NEW isolated preview state only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {createServer as createViteServer} from 'vite';
import react from '@vitejs/plugin-react';
import {main} from '../scripts/preview-quick-catalog.js';
import {runWithInput} from './helpers/previewPasswordProcess.js';
const run=promisify(execFile);

test('preview registration, normalized duplicate email, login, real logout storage, reset and restart preserve accounts, roles and all 47 listings', {timeout:120000}, async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rentsphere-auth-focused-'));
 process.env.RENTSPHERE_PREVIEW_PORT='0';process.env.RENTSPHERE_PREVIEW_STATE_DIR=directory;
 delete process.env.RENTSPHERE_PREVIEW_EPHEMERAL;
 let preview,vite,origin;
 const post=async(path,value)=>{
  const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  return {status:response.status,data:await response.json()};
 };
 try {
  preview=await main();origin='http://127.0.0.1:'+preview.server.address().port;
  const db=()=>mongoose.connection.db;
  const listings=mongoose.mongo.BSON.EJSON.stringify(await db().collection('listings').find({}).sort({_id:1}).toArray());
  const adminBefore=await db().collection('users').findOne({email:'admin@rentsphere.com'});
  assert.equal(adminBefore.role,'admin');assert.match(adminBefore.password,/^\$2/);
  const credentials={name:'Own email test',email:' My.Own.Email@Example.test ',password:'MyOwnPreviewPassword2026!',role:'admin'};
  const registration=await post('/api/auth/register',credentials);
  assert.equal(registration.status,201);assert.equal(registration.data.email,'my.own.email@example.test');assert.equal(registration.data.role,'user');
  const account=await db().collection('users').findOne({email:registration.data.email});
  assert.notEqual(account.password,credentials.password);assert.equal(await bcrypt.compare(credentials.password,account.password),true);
  for(const email of ['my.own.email@example.test',' MY.OWN.EMAIL@EXAMPLE.TEST ']) {
   const duplicate=await post('/api/auth/register',{...credentials,email});
   assert.equal(duplicate.status,400);assert.equal(duplicate.data.message,'User already exists');
  }
  const adminDuplicate=await post('/api/auth/register',{...credentials,email:'admin@rentsphere.com'});
  assert.equal(adminDuplicate.status,400);assert.equal(adminDuplicate.data.message,'User already exists');
  const login=await post('/api/auth/login',{email:' MY.OWN.EMAIL@EXAMPLE.TEST ',password:credentials.password});
  assert.equal(login.status,200);assert.equal(login.data._id,registration.data._id);
  assert.equal((await post('/api/auth/login',{email:registration.data.email,password:'wrong-password'})).status,401);
  assert.equal((await post('/api/auth/login',{email:'missing@example.test',password:'wrong-password'})).status,401);
  assert.equal(await db().collection('users').countDocuments({email:registration.data.email}),1);
  assert.equal((await fetch(origin+'/api/admin/bookings',{headers:{Authorization:'Bearer '+login.data.token}})).status,403);
  // Exercise actual AuthProvider login/logout storage operations. APIs remain
  // stateless JWT auth; logout removes the browser's session, not other devices.
  vite=await createViteServer({root:fileURLToPath(new URL('../../',import.meta.url)),configFile:false,envDir:false,plugins:[react()],server:{middlewareMode:true,hmr:false,ws:false,watch:null}});
  const {AuthContext,AuthProvider}=await vite.ssrLoadModule('/src/context/AuthContext.jsx');
  const React=(await import('react')).default;
  const {renderToStaticMarkup}=await import('react-dom/server');
  let context;const store=new Map();const previousStorage=globalThis.localStorage;
  globalThis.localStorage={getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)};
  try {
   function Capture(){context=React.useContext(AuthContext);return null;}
   renderToStaticMarkup(React.createElement(AuthProvider,null,React.createElement(Capture)));
   context.login(login.data);assert.equal(JSON.parse(store.get('rentsphere-user')).token,login.data.token);
   context.logout();assert.equal(store.has('rentsphere-user'),false);
   assert.equal((await fetch(origin+'/api/bookings/mybookings')).status,401);
  }finally{globalThis.localStorage=previousStorage;await vite.close();vite=null;}
  // Save all pending registration responses before testing the offline reset lock.
  await preview.preview.save();
  const statePath=join(directory,'state.json');
  const stateBefore=await readFile(statePath,'utf8');
  const script=fileURLToPath(new URL('../scripts/preview-admin.js',import.meta.url));
  await assert.rejects(run(process.execPath,[script,'--reset','admin@rentsphere.com'],{env:{...process.env}}),error=>{assert.match(error.stderr,/in use/);return true;});
  assert.equal(await readFile(statePath,'utf8'),stateBefore);
  await preview.close('focused authentication reset test');preview=null;
  const beforeReset=mongoose.mongo.BSON.EJSON.parse(await readFile(statePath,'utf8'));
  const password='ChosenAdminPassword2026!';
  const reset=await runWithInput(script,['--set-password','admin@rentsphere.com','--password-stdin'],`${password}\n${password}\n`,{env:{...process.env}});
  assert.ok(!reset.stdout.includes(password));assert.ok(!reset.stderr.includes(password));
  const afterReset=mongoose.mongo.BSON.EJSON.parse(await readFile(statePath,'utf8'));
  const modified=afterReset.collections.users.find(row=>row.email==='admin@rentsphere.com');
  assert.equal(await bcrypt.compare(password,modified.password),true);
  modified.password=adminBefore.password;assert.deepEqual(afterReset,beforeReset);
  preview=await main();origin='http://127.0.0.1:'+preview.server.address().port;
  const adminLogin=await post('/api/auth/login',{email:'admin@rentsphere.com',password});
  assert.equal(adminLogin.status,200);assert.equal(adminLogin.data.role,'admin');assert.equal(adminLogin.data._id,String(adminBefore._id));
  assert.equal((await fetch(origin+'/api/admin/bookings',{headers:{Authorization:'Bearer '+adminLogin.data.token}})).status,200);
  assert.equal((await post('/api/auth/login',{email:registration.data.email,password:credentials.password})).status,200);
  assert.equal((await fetch(origin+'/api/bookings/mybookings',{headers:{Authorization:'Bearer '+login.data.token}})).status,200);
  assert.equal(await db().collection('listings').countDocuments(),47);
  assert.equal(mongoose.mongo.BSON.EJSON.stringify(await db().collection('listings').find({}).sort({_id:1}).toArray()),listings);
 }finally{
  await vite?.close();await preview?.close('focused authentication test finished');
  for(const name of await readdir(directory))await unlink(join(directory,name));await rmdir(directory);
 }
});
