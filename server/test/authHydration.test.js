import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

test('B01 first render restores valid user/admin sessions before dashboard redirects can run', async () => {
  const vite=await createServer({root:fileURLToPath(new URL('../../',import.meta.url)),plugins:[react()],configFile:false,envDir:false,server:{middlewareMode:true,hmr:false,watch:null}});
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  let saved;
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>saved,removeItem:()=>{saved=null;}}});
  try {
    const {AuthProvider,AuthContext}=await vite.ssrLoadModule('/src/context/AuthContext.jsx');
    const probe=()=>React.createElement(AuthProvider,null,React.createElement(AuthContext.Consumer,null,
      ({user})=>React.createElement('span',null,user ? user.role+':'+user._id : 'anonymous')));
    for(const role of ['user','owner','admin']) {
      saved=JSON.stringify({_id:'existing-account',role,token:'existing-valid-session'});
      assert.equal(renderToString(probe()),`<span>${role}:existing-account</span>`);
      assert.ok(saved,'Valid storage is retained');
    }
    for(const invalid of [null,'{',JSON.stringify({token:'dummy-token'}),JSON.stringify({_id:'dummy',token:'fake'}),JSON.stringify({role:'admin'})]) {
      saved=invalid;assert.equal(renderToString(probe()),'<span>anonymous</span>');assert.equal(saved,null);
    }
  } finally {
    if(original)Object.defineProperty(globalThis,'localStorage',original);else delete globalThis.localStorage;
    await vite.close();
  }
});
