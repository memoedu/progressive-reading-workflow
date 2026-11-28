import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {digest, paths, writeJson} from '../subscription-workflow/config.mjs';
import {enqueueDiscoveryCycles, jobList} from '../subscription-workflow/service.mjs';
import {boundVideoDiscovery, generateVideoDiscovery} from '../subscription-workflow/video-discovery-stage.mjs';
import {discoveryRegistry, publishDiscoveryRegistry, captureDiscovery, readSealedDiscovery, receiveDiscovery,
  pendingDiscoveryCycles, acknowledgeDiscovery, latestDiscoveryCycle} from '../subscription-workflow/remote-discovery-capture.mjs';

const bvid='BV1234567890', url='https://www.bilibili.com/video/'+bvid+'/';
const sources=[{enabled:true,kind:'bilibili_collection',url},
  {enabled:true,kind:'zhihu_column',url:'https://www.zhihu.com/column/c_fixture'}];
const registry=discoveryRegistry({enabled:true,revision:37,subscriptions:sources});
const before='scheduled-2026-11-27',cycle='scheduled-2026-11-28';
const api=async()=>({bvid,title:'Public video',pages:[{cid:1,page:1,part:'Test',duration:40}],
  ugc_season:{id:99,ep_count:1,sections:[{episodes:[{bvid}]}]}});
const fixture=async()=>{
  const base=process.env.DISCOVERY_CAPTURE_TEST_HOME || os.tmpdir();
  await fs.mkdir(base,{recursive:true});
  return fs.mkdtemp(path.join(base,'discovery-offline-'));
};
const binding={enabled:true,scheduledCapture:true,host:'mac-mini-tailscale',home:'/Users/fixture'};

test('Mac seals unclaimed discoveries once, rejects stale configuration, and keeps consumption idempotent',async()=>{
  const home=await fixture();
  const published=await publishDiscoveryRegistry(home,registry);
  assert.equal(published.revision,37);
  assert.deepEqual(await publishDiscoveryRegistry(home,registry),published);
  await assert.rejects(publishDiscoveryRegistry(home,{...registry,revision:36}),/stale_revision/u);
  await assert.rejects(publishDiscoveryRegistry(home,{...registry,zhihu:[]}),/same_revision_conflict/u);
  let calls=0, request;
  const produce=async(kind,input)=>{calls++; request=input; return generateVideoDiscovery(input,api);};
  const receipt=await captureDiscovery(home,'bilibili',cycle,registry,{produce});
  assert.equal(receipt.status,'completed');
  assert.deepEqual(await captureDiscovery(home,'bilibili',cycle,registry,{produce}),receipt);
  assert.equal(calls,1);
  await assert.rejects(captureDiscovery(home,'bilibili',cycle,{...registry,revision:38},{produce}),/cycle_input_conflict/u);
  assert.deepEqual(await pendingDiscoveryCycles(home,'bilibili',cycle),[{cycle,revision:37,sha256:receipt.sha256}]);
  const sealed=await readSealedDiscovery(home,'bilibili',cycle,request);
  assert.equal(sealed.sha256,receipt.sha256);
  await assert.rejects(readSealedDiscovery(home,'bilibili',cycle,{...request,revision:38}),/capture_mismatch/u);
  await writeJson(path.join(home,'remote-video-discovery.json'),binding);
  const get=async(settings,kind,wanted)=>receiveDiscovery(settings,kind,wanted,{send:async()=>sealed});
  const watch={url,collection:true,season_id:99,subscription_id:'fixture'};
  const verify=watch=>boundVideoDiscovery(home,cycle,37,[watch],
    {receive:get,send:async()=>assert.fail('Autonomous reception must not start an on-demand collection')});
  assert.equal((await verify(watch)).receipt.captureSha256,receipt.sha256);
  assert.equal((await verify({...watch,season_id:100})).receipt.executor,'windows');
  const jobId=digest('bilibili:'+cycle).slice(0,32);
  const consumed=await acknowledgeDiscovery(home,'bilibili',cycle,{sha256:receipt.sha256,jobId});
  assert.deepEqual(await acknowledgeDiscovery(home,'bilibili',cycle,{sha256:receipt.sha256,jobId}),consumed);
  assert.deepEqual(await pendingDiscoveryCycles(home,'bilibili',cycle),[]);
  assert.deepEqual(await readSealedDiscovery(home,'bilibili',cycle,request),sealed);
});

test('the existing Windows scheduler recovers sealed cycles in order without creating a future or duplicate job',async()=>{
  const root=await fixture(),home=path.join(root,'state');
  await writeJson(paths(root).marker,{home});
  assert.equal(paths(root).home,home);
  await writeJson(paths(root).config,{revision:37});
  await writeJson(path.join(home,'remote-video-discovery.json'),binding);
  const now=new Date('2026-11-29T07:59:59+08:00');
  assert.equal(latestDiscoveryCycle('bilibili',now),cycle);
  assert.equal(latestDiscoveryCycle('zhihu',now),'scheduled-2026-11-29');
  const list=async(settings,kind,latest)=>{
    assert.equal(kind,'bilibili'); assert.equal(latest,cycle);
    return [{cycle,revision:37,sha256:'a'.repeat(64)},{cycle:before,revision:37,sha256:'b'.repeat(64)},
      {cycle:'scheduled-2026-11-26',revision:36,sha256:'c'.repeat(64)}];
  };
  const a=await enqueueDiscoveryCycles(root,'bilibili',{now,list,sync:async()=>null});
  const b=await enqueueDiscoveryCycles(root,'bilibili',{now,list,sync:async()=>null});
  assert.deepEqual(a,b);
  assert.deepEqual(a.jobs.map(row=>row.cycle),[before,cycle]);
  assert.equal((await jobList(root)).length,2);
});
