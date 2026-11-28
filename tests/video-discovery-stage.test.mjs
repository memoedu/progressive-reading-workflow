import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {scanVideos} from '../subscription-workflow/adapters.mjs';
import {digest,normalizeSource,paths,readJson,SCHEMA,writeJson} from '../subscription-workflow/config.mjs';
import {boundVideoDiscovery,generateVideoDiscovery,verifyVideoDiscovery} from '../subscription-workflow/video-discovery-stage.mjs';
import {canonicalUrl,discover,itemKey} from '../video-workflow/watch-core.mjs';

const cycle='scheduled-2026-11-29';
const ids=Array.from({length:33},(_,index)=>'BV'+String(index+1).padStart(10,'0'));
const [seed,second]=ids;
const request={schema:'progressive-reading.video-discovery/v1',cycle,revision:37,watches:[{bvid:seed,collection:true,season_id:15}]};
const watch={url:canonicalUrl(seed),collection:true,season_id:15};
const api=(members,{embedded=false,omitLast=false}={})=>async endpoint=>{
  const [route,query]=endpoint.split('?');
  const params=new URLSearchParams(query);
  if (route.endsWith('archives_list')) {
    const index=Number(params.get('page_num'));
    const archives=omitLast && index===2 ? [] : members.slice((index-1)*30,index*30).map(bvid=>({bvid}));
    return {page:{total:members.length},archives};
  }
  const bvid=params.get('bvid'), cid=(members.indexOf(bvid)+1)*10;
  return {bvid,title:'示例 '+bvid,duration:61,pubdate:1735689600,
    owner:{mid:29},ugc_season:bvid===seed ? {id:15,ep_count:members.length,
      sections:[{episodes:(embedded ? members : [seed]).map(id=>({bvid:id}))}]} : undefined,
    pages:bvid===seed ? [{cid,page:1,part:'开头',duration:30},{cid:cid+1,page:2,part:'后续',duration:31}] : [{cid,page:1,part:'单 P',duration:61}]};
};
const resign=response=>{response.resultSha256=digest(JSON.stringify(response.results));return response;};

test('the remote stage reuses the original discovery order and validates exact parts, pagination and cycle',async()=>{
  const response=await generateVideoDiscovery(request,api(ids));
  const [received]=verifyVideoDiscovery(request,response);
  assert.deepEqual(received.found,await discover(watch,{api:api(ids)}));
  assert.deepEqual(received.trace.archivePages,[{page:1,total:33,rows:30},{page:2,total:33,rows:3}]);
  assert.deepEqual(received.trace.viewBvids,ids);
  assert.deepEqual(received.found.items.slice(0,3).map(row=>row.key),[itemKey(seed,10),itemKey(seed,11),itemKey(second,20)]);
  assert.throws(()=>verifyVideoDiscovery({...request,revision:38},response),/receipt_mismatch/u);
  assert.throws(()=>verifyVideoDiscovery({...request,cycle:'scheduled-2026-11-30'},response),/receipt_mismatch/u);
  const incomplete=structuredClone(response);
  incomplete.results[0].trace.archivePages.pop();
  assert.throws(()=>verifyVideoDiscovery(request,resign(incomplete)),/incomplete_pagination/u);
  const reordered=structuredClone(response);
  [reordered.results[0].found.items[0],reordered.results[0].found.items[1]]=
    [reordered.results[0].found.items[1],reordered.results[0].found.items[0]];
  assert.throws(()=>verifyVideoDiscovery(request,resign(reordered)),/part_order_mismatch/u);
  const duplicate=structuredClone(response);
  duplicate.results[0].found.items.push(duplicate.results[0].found.items[0]);
  assert.throws(()=>verifyVideoDiscovery(request,resign(duplicate)),/invalid_item/u);
  await assert.rejects(generateVideoDiscovery(request,api(ids,{omitLast:true})),/collection_pagination_incomplete/u);
});

test('a single video never inherits its containing collection',async()=>{
  const single={...request,watches:[{bvid:seed,collection:false,season_id:null}]};
  const response=await generateVideoDiscovery(single,api(ids,{embedded:true}));
  const [result]=verifyVideoDiscovery(single,response);
  assert.equal(result.found.season_id,null);
  assert.deepEqual(result.trace,{viewBvids:[seed],archivePages:[]});
  assert.equal(result.found.items.length,2);
});

test('the Windows video worker keeps the old cursor, falls back and takes a new part only once',async()=>{
  const base=process.env.VIDEO_DISCOVERY_TEST_HOME || os.tmpdir();
  await fs.mkdir(base,{recursive:true});
  const root=await fs.mkdtemp(path.join(base,'video-discovery-'));
  const home=path.join(root,'subscription'), video=path.join(root,'video');
  const source=normalizeSource({kind:'bilibili_collection',name:'测试合集',url:watch.url,mode:'standard_preprocess',baseline_ready:true});
  const watchId=source.watch?.id || source.id;
  await writeJson(paths(root).marker,{home});
  await writeJson(paths(root).config,{schema:SCHEMA,enabled:true,revision:37,video_home:video,rss_home:path.join(root,'rss'),subscriptions:[source]});
  const initial=await discover(watch,{api:api([seed],{embedded:true})});
  const known=initial.items.map(item=>({...item,status:'completed',watch_ids:[watchId]}));
  const cursor=path.join(video,'state.json');
  await writeJson(cursor,{entries:Object.fromEntries(known.map(item=>[item.key,item])),
    watch_baselines:{[watchId]:{at:'2026-11-01T00:00:00Z',count:2,season_id:15}}});
  const bind=path.join(home,'remote-video-discovery.json');
  const settings={enabled:true,host:'mac-mini-tailscale',home:'/Users/fixture'};
  await writeJson(bind,settings);

  let windowsCalls=0,macCalls=0,processCalls=0;
  const run=send=>scanVideos(root,cycle,{
    discoverFn:async item=>{windowsCalls++; assert.equal(item.season_id,15); return initial;},
    existingFn:async()=>new Map(),
    processFn:async item=>{
      processCalls++;
      assert.equal(item.key,itemKey(second,20));
      return {status:'completed',publication:path.join(root,'fixture.md'),runDir:root};
    },
    discoverRemote:(...args)=>boundVideoDiscovery(...args,{send:async(binding,remoteRequest)=>{macCalls++;return send(remoteRequest);}})
  });
  assert.equal((await run(async()=>{throw Error('offline');})).discovery.fallback,'video_discovery_unavailable');
  assert.equal((await run(async req=>{
    const response=await generateVideoDiscovery(req,api([seed,second],{embedded:true}));
    response.results[0].found.items.splice(1,1);
    return resign(response);
  })).discovery.fallback,'video_discovery_incomplete_parts');
  assert.equal(windowsCalls,2);
  assert.equal(processCalls,0);
  const online=req=>generateVideoDiscovery(req,api([seed,second],{embedded:true}));
  assert.equal((await run(online)).discovery.executor,'mac');
  assert.equal((await run(online)).new_items.length,0);
  const state=await readJson(cursor);
  assert.equal(processCalls,1);
  assert.equal(Object.keys(state.entries).length,3);
  for(const item of known) assert.deepEqual(state.entries[item.key],item);
  assert.equal(state.watch_baselines[watchId].at,'2026-11-01T00:00:00Z');
  await writeJson(bind,{...settings,enabled:false});
  assert.equal((await run(online)).discovery,undefined);
  assert.equal(windowsCalls,3);
  assert.equal(macCalls,4);
  assert.equal(await readJson(path.join(home,'notifications.json')),null);
});
