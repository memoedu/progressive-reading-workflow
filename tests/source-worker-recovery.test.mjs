import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BrowserImportBroker} from '../scripts/browser-import-broker.mjs';
import {countActiveBrowserImports,IMPORT_STATE_SCHEMA,readBrowserImportState,saveBrowserImportState} from '../scripts/browser-import-state.mjs';

test('legacy broker history migrates once and later updates leave its bytes unchanged', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-import-state-lock-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const stateFile = path.join(root, 'state.json');
  const former = {id:'old-request', source:'obsidian_local_ir', transport:'background_fetch', createdAt:new Date(0).toISOString()};
  const failed = {id:'old-task', requestId:former.id, source:former.source, transport:former.transport,
    status:'failed', error:'synthetic_failure', updatedAt:new Date(0).toISOString()};
  const previous = JSON.stringify({schema:IMPORT_STATE_SCHEMA,requests:[former],tasks:[failed]});
  await fs.writeFile(stateFile,previous);
  const broker = new BrowserImportBroker({stateRoot:root});
  assert.equal((await broker.getRequest(former.id)).results[0].error,failed.error);
  const second = await broker.createRequest(['https://example.org/after'],{clientRequestId:'after-migration'});
  const claimed = await broker.claimTask('worker','claim',{requestId:second.request_id});
  assert.equal(await countActiveBrowserImports(root),1);
  await broker.completeTask(claimed.id,{ok:true,leaseToken:claimed.lease_token});
  const reader = new BrowserImportBroker({stateRoot:root});
  assert.equal((await reader.getRequest(second.request_id)).status,'completed');
  assert.equal((await reader.createRequest(['https://example.org/after'],{clientRequestId:'after-migration'})).request_id,second.request_id);
  assert.equal(await countActiveBrowserImports(root),0);
  assert.equal(await fs.readFile(stateFile,'utf8'),previous);
  assert.throws(()=>saveBrowserImportState(root,{requests:[{id:'uncommitted'}],tasks:[{id:'rejected',requestId:'missing',status:'queued'}]}),/FOREIGN KEY/u);
  const {value: accepted,migrated} = await readBrowserImportState(root);
  assert.equal(migrated,true);
  assert.deepEqual(accepted.requests.map(request=>request.id),[former.id,second.request_id]);
});

test('an exited singleton source worker resumes frozen work without discarding its collection',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-worker-recovery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let now=100000;const broker=new BrowserImportBroker({stateRoot:root,now:()=>now});
  const request=await broker.createRequest(['https://example.org/translated'],{source:'site_import_page',processingMode:'original_text',articleSource:{run_id:'site-run-fixture'}});
  const claimed=await broker.claimTask('local-background-url-fetcher-1','claim',{requestId:request.request_id});
  const collection={inventory:{complete:true,articles:[{url:'https://example.org/translated'}]},batches:[{request_id:'child',terminal:true}],results:[{requested_url:'https://example.org/translated',status:'imported'}]};
  await broker.updateTaskProgress(claimed.id,{collection},claimed.lease_token);
  now+=100;
  assert.equal((await broker.recoverExitedSourceWorkers(12345,{before:now,isAlive:()=>true})).recovered,0);
  assert.equal((await broker.recoverExitedSourceWorkers(12345,{before:now,isAlive:()=>false})).recovered,1);
  const next=await broker.claimTask('local-background-url-fetcher-1','claim2',{requestId:request.request_id});
  assert.deepEqual(next.collection,collection);
  const {value:saved}=await readBrowserImportState(root);assert.equal(saved.tasks[0].interruptedClaims.length,1);assert.equal(saved.tasks[0].attempts,1);
});
test('model work, external workers and newly claimed work are never reclaimed by source recovery',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-worker-model-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let now=100000;const broker=new BrowserImportBroker({stateRoot:root,now:()=>now});
  const ai=await broker.createRequest(['https://example.org/ai'],{processingMode:'standard_preprocess',articleSource:{run_id:'site-run-fixture'}});
  await broker.claimTask('local-background-url-fetcher-1','ai',{requestId:ai.request_id});
  const external=await broker.createRequest(['https://example.org/external'],{processingMode:'original_text',articleSource:{run_id:'site-run-fixture'}});
  await broker.claimTask('external-source-worker','external',{requestId:external.request_id});
  now+=100;const cutoff=now;
  const fresh=await broker.createRequest(['https://example.org/fresh'],{processingMode:'original_text',articleSource:{run_id:'site-run-fixture'}});
  await broker.claimTask('local-background-url-fetcher-2','fresh',{requestId:fresh.request_id});
  assert.equal((await broker.recoverExitedSourceWorkers(12345,{before:cutoff,isAlive:()=>false})).recovered,0);
  for(const request of [ai,external,fresh])assert.equal((await broker.getRequest(request.request_id)).active,1);
});

test('an original-text site collection resumes immediately only after its inventory is frozen',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'site-worker-frozen-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let now=100000;
  const broker=new BrowserImportBroker({stateRoot:root,now:()=>now});
  const make=async(name,complete)=>{const request=await broker.createRequest(['https://example.org/'+name],{source:'site_import_page',processingMode:'original_text',siteImport:{run_id:'site-run-'+name,settings:{url:'https://example.org/'+name}}});const task=await broker.claimTask('local-background-url-fetcher-1',name,{requestId:request.request_id});await broker.updateTaskProgress(task.id,{collection:{inventory:{complete,articles:[]},results:[]}},task.lease_token);return request;};
  const frozen=await make('frozen',true),planning=await make('planning',false);now+=100;
  assert.equal((await broker.recoverExitedSourceWorkers(12345,{before:now,isAlive:()=>false})).recovered,1);
  assert.equal((await broker.getRequest(frozen.request_id)).queued,1);assert.equal((await broker.getRequest(planning.request_id)).active,1);
});
