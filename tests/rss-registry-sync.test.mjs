import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeJson,readJson} from '../subscription-workflow/config.mjs';
import {publishFeedRegistry,registryState} from '../subscription-workflow/remote-feed-stage.mjs';
import {reconcileFeedRegistry} from '../subscription-workflow/rss-registry-sync.mjs';

test('saved registry catches up after downtime without replacing a sealed cycle or allowing rollback', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rss-registry-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const windows=path.join(root,'windows'), mac=path.join(root,'mac');
  const registry=path.join(mac,'registry.json');
  const local=path.join(windows,'subscriptions.json');
  const cycle=path.join(mac,'scheduled-2026-11-28','input.json');
  const config={enabled:true,revision:37,subscriptions:Array.from({length:7},(_,i)=>({
    id:'feed-'+i,url:'https://feeds.example.org/'+i,kind:'rss',enabled:true,name:'Windows-only name'
  }))};
  config.subscriptions.push({kind:'zhihu_column',enabled:true,url:'https://example.org/column'});
  await writeJson(local,config);
  await writeJson(registry,registryState(config).projection);
  await writeJson(cycle,{revision:37,existing:true});
  const originalCycle=await fs.readFile(cycle,'utf8');
  await writeJson(path.join(windows,'remote-rss-binding.json'),{enabled:true,host:'mac-fixture',home:'/Users/fixture'});
  let online=true;
  const send=async (_,op,input)=>{
    if(!online) throw Error('offline');
    if(op==='registry') return JSON.stringify(registryState(await readJson(registry)));
    assert.equal(op,'publish-registry');
    const projected=JSON.parse(input);
    assert(!input.includes('Windows-only'));
    assert(projected.subscriptions.every(source=>source.kind==='rss'));
    return JSON.stringify(await publishFeedRegistry(mac,projected));
  };
  config.revision=38;
  config.subscriptions[0].enabled=false;
  await writeJson(local,config);
  assert.deepEqual(await reconcileFeedRegistry(windows,{send}),{
    status:'replaced',revision:38,enabled:true,feeds:6,sha256:registryState(config).sha256
  });
  const revision38=await fs.readFile(registry,'utf8');
  assert.equal((await reconcileFeedRegistry(windows,{send})).status,'already_current');
  assert.equal(await fs.readFile(registry,'utf8'),revision38);
  online=false;
  config.revision=39;
  await writeJson(local,config);
  await assert.rejects(reconcileFeedRegistry(windows,{send}),/offline/u);
  assert.equal((await readJson(local)).revision,39);
  assert.equal((await readJson(registry)).revision,38);
  const revision39=registryState(config).projection;
  config.revision=40;
  await writeJson(local,config);
  online=true;
  assert.equal((await reconcileFeedRegistry(windows,{send})).revision,40);
  await assert.rejects(publishFeedRegistry(mac,revision39),/stale_registry_revision/u);
  await assert.rejects(publishFeedRegistry(mac,{...revision39,revision:40,subscriptions:[]}),/same_revision_source_conflict/u);
  assert.equal((await reconcileFeedRegistry(windows,{send,verify:true})).status,'verified');
  assert.equal(await fs.readFile(cycle,'utf8'),originalCycle);
});
