import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {digest,readJson,writeJson} from '../subscription-workflow/config.mjs';
import {materialKey} from '../subscription-workflow/catalog.mjs';
import {captureDiscovery,discoveryRegistry,publishDiscoveryRegistry} from '../subscription-workflow/remote-discovery-capture.mjs';
import {generateZhihuDiscovery} from '../subscription-workflow/zhihu-discovery-stage.mjs';
import {replayReportZhihu} from '../subscription-workflow/report-zhihu-replay.mjs';

const cycle='scheduled-'+new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',dateStyle:'short'}).format(new Date());
const url='https://www.zhihu.com/column/c_123', originalUrl='https://www.zhihu.com/column/c_456';
const entry=(id)=>({id,type:'article',title:'已封存正文',updated:1700000100,created:1700000000});
const ids=[101,102,103,104,105,106,107];
const articles=ids.map(entry);
const source={id:'reports',url,kind:'zhihu_column',enabled:true,mode:'reports',history_mode:'all',baseline_ready:true,seen:[]};
const plan={cycle,revision:4,rssCheckpoint:{knownKeys:[digest(materialKey('https://zhuanlan.zhihu.com/p/101'))],sources:[]},
  zhihuCheckpoint:{sources:[source]}};

test('Zhihu report replay requires a verified column, body identity and revision, and caches the validated request once',async t=>{
  const top=await fs.mkdtemp(path.join(os.tmpdir(),'report-zhihu-replay-'));
  t.after(()=>fs.rm(top,{recursive:true,force:true}));
  const home=path.join(top,'reports'), capture=path.join(top,'SubscriptionDiscoveryCapture');
  const registry=discoveryRegistry({enabled:true,revision:4,subscriptions:[source,{...source,id:'original',url:originalUrl,mode:'original_text'}]});
  await publishDiscoveryRegistry(capture,registry);
  const produce=(_,request)=>generateZhihuDiscovery(request,async target=>{
    if(target.endsWith('/me'))return {id:'tester'};
    if(target.includes('/pinned-items/'))return {data:[]};
    const data=target.includes('/c_123/')?articles:[entry(200)];
    return {data,paging:{totals:data.length,is_end:true}};
  });
  await captureDiscovery(capture,'zhihu',cycle,registry,{produce});
  const html='<p>'+'已经验证同一个专栏下的全文和修订。'.repeat(160)+'</p>';
  let scans=0, previews=0;
  async function readBodies(groups){
    scans++;
    assert.deepEqual(groups.map(group=>group.url),[url]);
    assert.equal(groups[0].items.length,6);
    return new Map([[url,new Map(groups[0].items.map(item=>{
      const body={method:'zhihu_column_embedded_body',html,url:item.url,revision:item.revision};
      if(item.key.endsWith(':103'))body.revision='1700000200';
      if(item.key.endsWith(':104'))body.url='https://zhuanlan.zhihu.com/p/1000';
      if(item.key.endsWith(':105'))return [item.key,{reason:'zhihu_report_column_body_incomplete'}];
      if(item.key.endsWith(':106'))body.html='<iframe></iframe>'+html;
      if(item.key.endsWith(':107'))body.html='<p>短文</p>';
      return [item.key,body];
    }))]]);
  }
  async function preparePreview(_,item){
    previews++;
    const raw=await fs.readFile(item.preprocess_request_path);
    assert.equal(digest(raw),item.preprocess_request_sha256);
    const result_path=item.preprocess_request_path+'.preview';
    await fs.writeFile(result_path,'preview');
    item.review_preview={result_path};
    return {input:{id:item.material_id,direct:false,length:item.meaningful_length,preview:{status:'ready',core:'测试'}},
      previewSha256:digest('preview'),consumerSha256:digest(raw)};
  }
  const run=current=>replayReportZhihu(home,current||plan,{readBodies,preparePreview});
  const first=await run();
  assert.equal(first.status,'provisional_draft');
  assert.equal(first.items.length,1);
  assert.equal(first.items[0].url,'https://zhuanlan.zhihu.com/p/102');
  assert.equal(first.items[0].sourceRevision,'1700000100');
  assert.deepEqual(first.pending.map(row=>row.reason),['zhihu_report_article_revision_changed','zhihu_report_article_revision_changed',
    'zhihu_report_column_body_incomplete','zhihu_report_article_body_unverified','short_report_delivery_owned_by_windows']);
  assert.deepEqual(await run(),first);
  assert.equal(scans,1);
  assert.equal(previews,1);
  assert.equal((await run({...plan,revision:5})).reason,'zhihu_report_capture_wrong_scope_or_revision');
  assert.equal((await run({...plan,zhihuCheckpoint:{sources:[{...source,url:'https://www.zhihu.com/column/c_999'}]}})).reason,
    'zhihu_report_capture_wrong_scope_or_revision');
  await fs.appendFile(first.items[0].requestFile,'changed');
  assert.equal((await run()).reason,'zhihu_report_replayed_artifact_changed');
  const file=path.join(capture,'zhihu',cycle,'receipt.json');
  await writeJson(file,{...await readJson(file),revision:3});
  assert.equal((await run()).reason,'zhihu_report_capture_integrity_failed');
});
