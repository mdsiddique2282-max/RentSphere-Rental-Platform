import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {lockPreviewState} from '../utils/previewStateLock.js';
import {runWithInput} from './helpers/previewPasswordProcess.js';
const run=promisify(execFile);
const script=fileURLToPath(new URL('../scripts/preview-admin.js',import.meta.url));
test('chosen local password refuses active preview, changes only named account hash, preserves all records and creates backup without leaking plaintext',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rentsphere-admin-reset-'));
 const options={env:{...process.env,RENTSPHERE_PREVIEW_STATE_DIR:directory}};
 const file=join(directory,'state.json');
 const state={version:1,secret:'saved-preview-secret',collections:{users:[{email:'admin@rentsphere.com',role:'admin',password:await bcrypt.hash('OriginalLocalPassword!',10)},{email:'guest@test.local',role:'user',password:'unchanged-guest-hash'}],bookings:[{requestId:'preserved-booking'}],listings:[{title:'Preserved property'}]}};
 const original=mongoose.mongo.BSON.EJSON.stringify(state);await writeFile(file,original);
 try {
  const release=await lockPreviewState(directory);
  try {await assert.rejects(run(process.execPath,[script,'--reset','admin@rentsphere.com'],options),error=>{assert.match(error.stderr,/in use/);return true;});}
  finally{await release();}
  assert.equal(await readFile(file,'utf8'),original);
  await assert.rejects(run(process.execPath,[script,'--reset','guest@test.local'],options));
  assert.equal(await readFile(file,'utf8'),original);
  await writeFile(join(directory,'admin-login.json'),JSON.stringify({email:'preview-admin@rentsphere.test',password:'ObsoletePlaintextFixture!'}));
  const password='ChosenLocalPassword2026!';
  const result=await runWithInput(script,['--set-password','admin@rentsphere.com','--password-stdin'],`${password}\n${password}\n`,options);
  assert.ok(!result.stdout.includes(password));assert.ok(!result.stderr.includes(password));
  await assert.rejects(readFile(join(directory,'admin-login.json')),{code:'ENOENT'});
  const changed=mongoose.mongo.BSON.EJSON.parse(await readFile(file,'utf8'));
  assert.equal(await bcrypt.compare(password,changed.collections.users[0].password),true);
  changed.collections.users[0].password=state.collections.users[0].password;
  assert.deepEqual(changed,state);
  const backup=(await readdir(directory)).find(name=>name.startsWith('state-before-admin-reset-'));
  assert.ok(backup);assert.equal(await readFile(join(directory,backup),'utf8'),original);
  const beforeNormalReset=await readFile(file,'utf8');
  const normalPassword='ChosenGuestPassword2026!';
  const normalResult=await runWithInput(script,['--reset-account',' GUEST@TEST.LOCAL ','--password-stdin'],`${normalPassword}\n${normalPassword}\n`,options);
  assert.ok(!normalResult.stdout.includes(normalPassword));
  const normalChanged=mongoose.mongo.BSON.EJSON.parse(await readFile(file,'utf8'));
  assert.equal(await bcrypt.compare(normalPassword,normalChanged.collections.users[1].password),true);
  assert.equal(normalChanged.collections.users[1].role,'user');
  normalChanged.collections.users[1].password='unchanged-guest-hash';
  assert.deepEqual(normalChanged,mongoose.mongo.BSON.EJSON.parse(beforeNormalReset));
  const missing=await readFile(file,'utf8');
  await assert.rejects(run(process.execPath,[script,'--reset-account','missing@test.local'],options));
  assert.equal(await readFile(file,'utf8'),missing);
  for(const input of ['short\nshort\n','ChosenPassword!\nMismatch!\n','      \n      \n',`${'a'.repeat(73)}\n${'a'.repeat(73)}\n`]) {
    await assert.rejects(runWithInput(script,['--set-password','admin@rentsphere.com','--password-stdin'],input,options));
    assert.equal(await readFile(file,'utf8'),missing);
  }
  // Default invocation must not disclose an old plaintext credential sidecar.
  await writeFile(join(directory,'admin-login.json'),JSON.stringify({email:'preview-admin@rentsphere.test',password:'LegacyPlaintextFixtureOnly!'}));
  const help=await run(process.execPath,[script],options);
  assert.ok(!help.stdout.includes('LegacyPlaintextFixtureOnly!'));
  assert.match(help.stdout,/--set-password/);
  for(const name of await readdir(directory)) if(name!=='admin-login.json') {
    const text=await readFile(join(directory,name),'utf8');
    assert.ok(!text.includes(password));assert.ok(!text.includes(normalPassword));
  }
 }finally{for(const name of await readdir(directory))await unlink(join(directory,name));await rmdir(directory);}
});
