import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {boundZhihuDiscovery,generateZhihuDiscovery,verifyZhihuDiscovery} from '../subscription-workflow/zhihu-discovery-stage.mjs';
import {scanZhihu} from '../subscription-workflow/adapters.mjs';
import {externalCatalog} from '../subscription-workflow/catalog.mjs';
import {digest,normalizeSource,paths,readJson,SCHEMA,writeJson} from '../subscription-workflow/config.mjs';

const cycle = 'scheduled-2026-11-29';
const source = normalizeSource({kind:'zhihu_column',name:'订阅专栏',url:'https://www.zhihu.com/column/c_fixture',mode:'original_text'});
const firstUrl = 'https://zhuanlan.zhihu.com/p/1';
const nextUrl = 'https://www.zhihu.com/question/2/answer/2109942199999999999';
const article = {type:'article',id:'1',title:'旧文章',created:1735689600};
const answer = {type:'answer',id:'2109942199999999999',question:{id:'2',title:'新回答'},created:1735689600,
  content:'<p>不经发现阶段传输的原正文。</p>'};
const readPages = (nextOffset=20) => async url=>{
  const target=new URL(url);
  if (target.pathname === '/api/v4/me') return {id:'synthetic_account'};
  if (target.pathname.endsWith('/pinned-items/v2')) return {data:[]};
  return target.searchParams.get('offset') === '0'
    ? {data:[article],paging:{totals:3,is_end:false,next:'http://www.zhihu.com/api/v4/columns/c_fixture/items?offset='+nextOffset+'&limit=20'}}
    : {data:[answer],paging:{totals:3,is_end:true}};
};
const request = {schema:'progressive-reading.zhihu-discovery/v1',cycle,revision:37,sources:[source.url]};
const resign = result=>{result.resultSha256=digest(JSON.stringify(result.columns)); return result;};

async function fixture(configured) {
  const testBase = process.env.ZHIHU_DISCOVERY_TEST_HOME || os.tmpdir();
  await fs.mkdir(testBase,{recursive:true});
  const root = await fs.mkdtemp(path.join(testBase,'zhihu-discovery-'));
  const home=path.join(root,'subscriptions'),rssHome=path.join(root,'rss');
  await writeJson(paths(root).marker,{home});
  await writeJson(paths(root).config,{schema:SCHEMA,enabled:true,revision:37,rss_home:rssHome,rss_defaults:{},subscriptions:[configured]});
  await writeJson(path.join(home,'remote-zhihu-discovery.json'),{enabled:true,host:'mac-mini-tailscale',home:'/Users/fixture'});
  const cursor=path.join(home,'zhihu-state.json');
  await writeJson(cursor,{sources:{[configured.id]:{baseline_at:'2026-11-01T00:00:00Z',seen:[firstUrl]}},entries:{}});
  return {root,home,rssHome,cursor};
}

test('the Mac collection stage keeps exact IDs and the original count warning, and rejects skipped pages',async()=>{
  const result = await generateZhihuDiscovery(request,readPages());
  const column = verifyZhihuDiscovery(request,result).get(source.url);
  assert.deepEqual(column.pages.map(page=>page.offset),[0,20]);
  assert.equal(column.materials[1].url,nextUrl);
  assert.equal('html' in column.materials[1],false);
  assert.equal(column.warnings[0].code,'zhihu_column_count_discrepancy');
  assert.equal(column.warnings[0].actual_count,2);
  assert.throws(()=>verifyZhihuDiscovery({...request,revision:38},result),/receipt_mismatch/u);
  const incomplete = structuredClone(result);
  incomplete.columns[0].pages.pop();
  assert.throws(()=>verifyZhihuDiscovery(request,resign(incomplete)),/incomplete_pages/u);
  const droppedWarning=structuredClone(result);
  droppedWarning.columns[0].warnings=[];
  droppedWarning.columns[0].complete=true;
  assert.throws(()=>verifyZhihuDiscovery(request,resign(droppedWarning)),/invalid_warning/u);
  await assert.rejects(generateZhihuDiscovery(request,readPages(40)),/incomplete_pages/u);
});

test('the original Windows scanner keeps its cursor, enqueues the new ID once, and falls back offline or on a partial receipt',async()=>{
  const {root,home,rssHome,cursor}=await fixture(source);
  let localCalls=0;
  const run = send=>scanZhihu(root,cycle,{access:()=>({}),discoverRemote:(...args)=>boundZhihuDiscovery(...args,{send}),
    discoverColumn:async()=>{localCalls++;return {materials:[{url:firstUrl,title:'旧文章'}]};}});
  const valid = async (binding,input)=>generateZhihuDiscovery(input,readPages());
  const offline = await run(async()=>{throw new Error('ssh_fixture_offline');});
  assert.equal(offline.discovery.fallback,'zhihu_remote_unavailable');
  assert.equal(localCalls,1);
  const partial = await run(async(binding,input)=>{
    const result = await generateZhihuDiscovery(input,readPages());
    result.columns[0].pages.pop();
    return resign(result);
  });
  assert.equal(partial.discovery.fallback,'zhihu_remote_incomplete_pages');
  assert.equal(localCalls,2);
  assert.deepEqual((await readJson(cursor)).sources[source.id].seen,[firstUrl]);
  const accepted = await run(valid);
  assert.equal(accepted.discovery.executor,'mac');
  assert.equal(accepted.warnings.length,1);
  assert.equal(localCalls,2);
  const entries = await readJson(cursor);
  assert.deepEqual(entries.sources[source.id].seen,[firstUrl,nextUrl]);
  assert.deepEqual(Object.keys(entries.entries),[nextUrl]);
  const queueFile=path.join(rssHome,'state.json');
  const queue=(await readJson(queueFile)).items;
  assert.equal(Object.values(queue)[0].url,nextUrl);
  await run(valid);
  assert.deepEqual((await readJson(queueFile)).items,queue);
  assert.equal((await readJson(path.join(home,'notifications.json'))),null);
});

test('report mode reads the body on Windows only and preserves its embedded fallback and single review material',async()=>{
  const configured={...source,mode:'reports'};
  const {root,home,cursor}=await fixture(configured);
  await writeJson(path.join(root,'.local-ir','subscription-library-sync.json'),{enabled:false});
  let pageReads=0, columnReads=0;
  const run=()=>scanZhihu(root,cycle,{access:()=>({}),discoverRemote:(...args)=>boundZhihuDiscovery(...args,
    {send:async(binding,input)=>generateZhihuDiscovery(input,readPages())}),
    fetchPage:async url=>{assert.equal(url,nextUrl);pageReads++;throw Error('page unavailable');},
    discoverColumn:async()=>{
      columnReads++;
      return {materials:[{key:'zhihu:answers:'+answer.id,url:nextUrl,revision:'',html:answer.content}]};
    }});
  assert.deepEqual((await run()).errors,[]);
  assert.deepEqual((await run()).errors,[]);
  assert.equal(pageReads,1);
  assert.equal(columnReads,1);
  assert.deepEqual(Object.keys((await readJson(cursor)).entries),[nextUrl]);
  assert.equal((await externalCatalog(root)).length,1);
  assert.equal(await readJson(path.join(home,'notifications.json')),null);
});
