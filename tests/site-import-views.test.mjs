import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {handleImportCenter} from '../site-import/http.mjs';
import {runId,saveRun,readRun,saveSiteSource} from '../site-import/store.mjs';
import {startSiteRun} from '../site-import/tasks.mjs';

test('compact run view retains every article and audit field without duplicate result payloads',async()=>{
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/site-view-');
  const results=Array.from({length:500},(_,i)=>({requested_url:`https://independent.example/article/${i}`,status:i===499?'failed':'imported',receipt:{evidence:'source evidence '.repeat(250)},errors:i===499?[{code:'fixture_failure'}]:[]}));
  const run={id:runId(root),created_at:new Date().toISOString(),results,collection:{results,inventory:{complete:true,articles:results.map(row=>({url:row.requested_url}))},error:'fixture_failure',verification:{verified:499}}};
  await saveRun(root,run);
  async function get(url){let status,body;const handled=await handleImportCenter({method:'GET',url,headers:{host:'127.0.0.1:12345'},socket:{remoteAddress:'127.0.0.1'}},{writeHead(code){status=code;},end(value){body=value;}},{root});assert.equal(handled,true);assert.equal(status,200);return {body,value:JSON.parse(body)};}
  const state=await get('/api/site-imports');assert.equal(state.value.capabilities.infer_topics,true);
  const full=await get('/api/site-imports/runs/'+run.id),compact=await get('/api/site-imports/runs/'+run.id+'?view=compact');
  assert.ok(Buffer.byteLength(full.body)>3_000_000);assert.ok(Buffer.byteLength(compact.body)<3_000_000);
  assert.deepEqual(compact.value.results,results);assert.equal(compact.value.detail_view,'compact');assert.equal(Object.hasOwn(compact.value.collection,'results'),false);
  assert.deepEqual(compact.value.collection.inventory,run.collection.inventory);assert.equal(compact.value.collection.error,'fixture_failure');assert.deepEqual(compact.value.collection.verification,run.collection.verification);
  assert.deepEqual(full.value,run);assert.deepEqual(await readRun(root,run.id),run);
});

test('a terminal broker receipt releases a stale site run and preserves its candidate snapshot',async t=>{
  const root=await fs.mkdtemp(path.join(process.env.WEB_IMPORT_TEST_ROOT||'D:/Artifacts/ProgressiveReading','site-run-status-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const {source}=await saveSiteSource(root,{url:'https://independent.example/',name:'Independent'},0);
  const recorded={id:runId('first'),request_id:'request-first',source_id:source.id,settings:source,
    phase:'discovering',created_at:new Date().toISOString(),results:[]};
  await saveRun(root,recorded);
  const articles=[{url:'https://independent.example/article'}];
  let receipt={terminal:false};
  let created=0;
  const broker={
    async getRequest(id){assert.equal(id,recorded.request_id);return receipt;},
    async createRequest(_urls,options){assert.equal(options.siteImport.settings.id,source.id);created++;return {request_id:'request-new'};}
  };
  async function get(url){
    let body;
    await handleImportCenter({method:'GET',url,headers:{host:'127.0.0.1:12345'},socket:{remoteAddress:'127.0.0.1'}},
      {writeHead(status){assert.equal(status,200);},end(value){body=JSON.parse(value);}},{root,broker});
    return body;
  }
  const start=()=>startSiteRun(root,{source_id:source.id,client_request_id:'fresh'},broker,async()=>{});
  assert.equal((await start()).id,recorded.id);
  assert.equal(created,0);

  receipt={terminal:true,updated_at:new Date().toISOString(),results:[{
    status:'failed',error:'fixture_progress_snapshot_failed',collection:{phase:'discovering',inventory:{complete:true,articles},results:[]}
  }]};
  const listing=await get('/api/site-imports');
  assert.equal(listing.sources[0].last_run.phase,'failed');
  assert.equal(listing.sources[0].last_run.error,'fixture_progress_snapshot_failed');
  const detail=await get('/api/site-imports/runs/'+recorded.id+'?view=compact');
  assert.equal(detail.phase,'failed');
  assert.deepEqual(detail.collection.inventory.articles,articles);
  assert.equal(detail.counts.discovered,1);
  assert.equal((await readRun(root,recorded.id)).phase,'discovering');
  const next=await start();
  assert.equal(next.id,runId('fresh'));
  assert.equal(next.request_id,'request-new');
  assert.equal(created,1);
  let relaunched=false;
  assert.equal((await startSiteRun(root,{source_id:source.id,client_request_id:'first'},broker,async()=>{relaunched=true;})).phase,'failed');
  assert.equal(relaunched,false);
});

test('topic checkbox persists explicit choices across refresh and degrades safely with older backends',async()=>{
  const html=await fs.readFile(new URL('../site-import/web/index.html',import.meta.url),'utf8');
  const code=(await fs.readFile(new URL('../site-import/web/app.mjs',import.meta.url),'utf8')).replace("'/import/client.mjs'",JSON.stringify(new URL('../scripts/browser-import-web/client.mjs',import.meta.url).href));
  const {mountImportCenter}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  const dom=new JSDOM(html,{url:'http://127.0.0.1/imports'}),doc=dom.window.document;
  let source={id:'fixture',name:'Independent',url:'https://independent.example/',destination:'整站/Independent',processing_mode:'standard_preprocess',infer_topics:true,subscribe_rss:true,generate_guide:false},capabilities={infer_topics:true},saved=[];
  const app=mountImportCenter(doc,{pollMs:100000,fetchImpl:async(url,options)=>{
    let result;if(url==='/api/site-imports')result={revision:saved.length,sources:[source],runs:[],capabilities};
    else if(url.endsWith('/history'))result={requests:[],legacy_jobs:[]};
    else if(url.endsWith('/source')){const body=JSON.parse(options.body);saved.push(body.source);source={...source,...body.source,include_paths:body.source.include_paths.split('\n').filter(Boolean),exclude_paths:body.source.exclude_paths.split('\n').filter(Boolean)};result={source};}
    else throw Error('unexpected '+url);return new Response(JSON.stringify(result));
  }});
  async function save(){doc.getElementById('site-form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));const deadline=Date.now()+2000;while(!doc.getElementById('site-editor').hidden||doc.getElementById('site-save').disabled){assert.ok(Date.now()<deadline,'save did not settle');await new Promise(resolve=>setTimeout(resolve,5));}}
  try{
    await app.refresh();app.editor(source);const field=doc.getElementById('site-infer-topics');assert.equal(field.disabled,false);assert.equal(field.closest('label').hidden,false);assert.equal(field.checked,true);
    field.checked=false;await app.refresh();assert.equal(field.checked,false);await save();assert.equal(saved.at(-1).infer_topics,false);assert.equal(saved.at(-1).subscribe_rss,true);assert.equal(saved.at(-1).generate_guide,false);
    app.editor(source);field.checked=true;await save();assert.equal(saved.at(-1).infer_topics,true);
    capabilities=undefined;await app.refresh();app.editor(source);assert.equal(field.disabled,true);assert.equal(field.closest('label').hidden,true);await save();assert.equal(Object.hasOwn(saved.at(-1),'infer_topics'),false);
  }finally{app.stop();dom.window.close();}
});

test('a delayed start shows the pending receipt and blocks duplicate clicks across polling',async()=>{
  const html=await fs.readFile(new URL('../site-import/web/index.html',import.meta.url),'utf8');
  const code=(await fs.readFile(new URL('../site-import/web/app.mjs',import.meta.url),'utf8')).replace("'/import/client.mjs'",JSON.stringify(new URL('../scripts/browser-import-web/client.mjs',import.meta.url).href));
  const {mountImportCenter}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  const dom=new JSDOM(html,{url:'http://127.0.0.1/imports'}),doc=dom.window.document;
  const source={id:'fixture',name:'Fixture',url:'https://independent.example/'};
  const run={id:'run',phase:'queued',settings:{...source}};
  const response=Promise.withResolvers();
  let starts=0;
  const app=mountImportCenter(doc,{pollMs:100000,fetchImpl:async url=>{
    if(url==='/api/site-imports/start'){starts++;return response.promise;}
    if(url==='/api/site-imports')return Response.json({sources:[source],runs:[]});
    if(url.endsWith('/history'))return Response.json({requests:[],legacy_jobs:[]});
    return Response.json(run);
  }});
  try{
    await app.refresh();
    const work=app.start(source);
    await app.refresh();
    assert.match(doc.getElementById('site-sources').textContent,/正在提交，等待后台确认/u);
    assert.equal(doc.querySelector('[data-focus="fixture-start"]').disabled,true);
    await app.start(source);
    assert.equal(starts,1);
    source.last_run=run;
    response.resolve(Response.json(run));
    await work;
    assert.match(doc.getElementById('site-sources').textContent,/排队中/u);
  }finally{app.stop();dom.window.close();}
});
