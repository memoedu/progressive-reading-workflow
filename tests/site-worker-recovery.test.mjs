import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {BrowserImportBroker} from '../scripts/browser-import-broker.mjs';
test('dead site-capture workers resume promptly while interrupted planning retains its lease',async()=>{
 for(const phase of ['planning','discovering']){
  const stateRoot=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/recovery-test-');
  const broker=new BrowserImportBroker({stateRoot});
  const request=await broker.createRequest(['https://independent.example/'],{source:'site_import_page',clientRequestId:'fixture-'+phase,processingMode:'standard_preprocess',siteImport:{run_id:'site-run-'+'1'.repeat(24),settings:{url:'https://independent.example/'}}});
  const task=await broker.claimTask('local-background-url-fetcher-1','claim-'+phase,{requestId:request.request_id});
  await broker.updateTaskProgress(task.id,{collection:{phase,discovery:{phase}}},task.lease_token);
  const result=await broker.recoverExitedSourceWorkers(999999,{before:Date.now()+1000,isAlive:()=>false});
  assert.equal(result.recovered,phase==='discovering'?1:0);
  const next=await broker.getRequest(request.request_id);assert.equal(next.status,phase==='discovering'?'queued':'processing');
 }
});
