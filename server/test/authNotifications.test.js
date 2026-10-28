import test from 'node:test';
import assert from 'node:assert/strict';
import { submitAuthentication } from '../../src/data/authentication.js';
import { createToastStore, TOAST_DURATION } from '../../src/data/toasts.js';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';

const values={name:'Chosen User',email:'chosen@example.test',password:'ChosenPassword2026!'};
const session={_id:'existing-account-id',token:'valid-session-token',role:'user'};
function harness(response, overrides={}) {
  const events=[];
  return {events,args:{values,register:false,
    fetcher:async()=>response,login:data=>events.push(['login',data]),
    notify:(message,type)=>events.push(['toast',message,type]),navigate:path=>events.push(['navigate',path]),...overrides}};
}

test('login/registration use the exact chosen credentials and show success before navigation',async()=>{
  for(const register of [false,true]) for(const role of ['user','admin']) {
    const h=harness(null,{register,fetcher:async(url,options)=>{
      assert.equal(url,register?'/api/auth/register':'/api/auth/login');
      assert.deepEqual(JSON.parse(options.body),values);
      return {ok:true,json:async()=>({...session,role})};
    }});
    const result=await submitAuthentication(h.args);
    assert.equal(result.success,register?'Account created successfully!':'Logged in successfully!');
    assert.deepEqual(h.events.map(event=>event[0]),['login','toast','navigate']);
    assert.deepEqual(h.events[1],['toast',result.success,'success']);
    assert.equal(h.events[2][1],role==='admin'?'/admin':'/dashboard');
  }
});

test('invalid credentials, duplicate email, validation and server/network failures show precise red errors without session/navigation',async()=>{
  for(const [register,status,message,expected] of [
    [false,401,'Invalid email or password','Invalid email or password.'],
    [false,500,'Internal details','Unable to log in. Please try again.'],
    [false,503,'Unavailable','Unable to log in. Please try again.'],
    [true,400,'User already exists','This email is already registered.'],
    [true,400,'A valid email is required.','A valid email is required.'],
    [true,500,'Internal details','Unable to create account. Please try again.'],
  ]) {
    const h=harness({ok:false,status,json:async()=>({message})},{register});
    assert.equal((await submitAuthentication(h.args)).error,expected);
    assert.deepEqual(h.events,[['toast',expected,'error']]);
  }
  for(const fetcher of [async()=>{throw new Error('Network');},async()=>({ok:false,status:502,json:async()=>{throw new Error('Invalid JSON');}})]) {
    const h=harness(null,{fetcher});
    assert.equal((await submitAuthentication(h.args)).error,'Unable to log in. Please try again.');
    assert.equal(h.events.length,1);
  }
});

test('inline-compatible validation rejects bad inputs before fetch and retains login compatibility with existing short passwords',async()=>{
  for(const invalid of [{name:''},{email:'not-an-email'},{email:'a@@example.test'},{password:'x'},{password:'a'.repeat(73)}]) {
    const h=harness(null,{register:true,values:{...values,...invalid},fetcher:()=>{throw new Error('Must not fetch');}});
    const result=await submitAuthentication(h.args);
    assert.ok(result.error);assert.deepEqual(h.events,[['toast',result.error,'error']]);
  }
  const h=harness({ok:true,json:async()=>session},{values:{...values,password:'x'}});
  assert.equal((await submitAuthentication(h.args)).success,'Logged in successfully!');
});

test('toasts deduplicate, replace previous messages and expire after 3.5 seconds without a duplicate extending the timer',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const store=createToastStore();let updates=0;
  const unsubscribe=store.subscribe(()=>updates++);
  store.show('Logged in successfully!','success');
  const snapshot=store.getSnapshot();
  t.mock.timers.tick(1000);store.show('Logged in successfully!','success');
  assert.equal(store.getSnapshot(),snapshot);assert.equal(updates,1);
  t.mock.timers.tick(TOAST_DURATION-1001);assert.ok(store.getSnapshot());
  t.mock.timers.tick(1);assert.equal(store.getSnapshot(),null);
  store.show('First','error');t.mock.timers.tick(1000);store.show('Second','success');
  t.mock.timers.tick(2500);assert.equal(store.getSnapshot().message,'Second');
  t.mock.timers.tick(1000);assert.equal(store.getSnapshot(),null);
  store.show('Dismiss','error');store.dismiss();assert.equal(store.getSnapshot(),null);
  unsubscribe();
});

test('real toast viewport keeps success across page navigation and exposes accessible success/error states',async()=>{
  const vite=await createServer({root:fileURLToPath(new URL('../../',import.meta.url)),plugins:[react()],configFile:false,envDir:false,server:{middlewareMode:true,hmr:false,ws:false,watch:null}});
  let store;
  try {
    const {default:ToastViewport}=await vite.ssrLoadModule('/src/components/ToastViewport.jsx');
    ({toastStore:store}=await vite.ssrLoadModule('/src/data/toasts.js'));
    const page=route=>React.createElement(React.Fragment,null,React.createElement('main',null,route),React.createElement(ToastViewport));
    store.show('Logged in successfully!','success');
    for(const route of ['/login','/dashboard','/admin']) {
      const html=renderToStaticMarkup(page(route));
      assert.match(html,/Logged in successfully!/);assert.match(html,/toast-success/);assert.match(html,/role="status"/);
    }
    store.show('Invalid email or password.','error');
    const html=renderToStaticMarkup(page('/login'));
    assert.match(html,/toast-error/);assert.match(html,/role="alert"/);
    assert.equal((html.match(/Invalid email or password\./g)||[]).length,1);
  }finally{store?.dismiss();await vite.close();}
});
