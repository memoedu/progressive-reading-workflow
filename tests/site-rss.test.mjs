import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {pathToFileURL} from 'node:url';
import {ensureSiteRss} from '../site-import/rss.mjs';
import {normalizeSiteSource} from '../site-import/store.mjs';
import {siteProcessingOptions} from '../site-import/tasks.mjs';
import {paths,writeJson,loadConfig,sourceProcessingOptions,SCHEMA} from '../subscription-workflow/config.mjs';
import {resolveProcessingPlan} from '../standard-preprocessing/lib/workflow-plan.mjs';

test('site default preserves structure, translates English and omits guide; explicit no-translation remains available',()=>{
 const source=normalizeSiteSource({url:'https://another.example',name:'Independent'}),options=siteProcessingOptions(source);
 assert.equal(source.processing_mode,'standard_preprocess');assert.equal(source.generate_guide,false);assert.equal(source.subscribe_rss,false);
 for(const language of ['en','zh']){
  const plan=resolveProcessingPlan(options,{input_form:'written',source_language:language,content_profile:'natural_language'});
  assert.equal(plan.body_mode,'preserve');assert.equal(plan.choices.include_reading_guide.enabled,false);assert.equal(plan.choices.translate.enabled,language==='en');
 }
 assert.equal(normalizeSiteSource({url:source.url,processing_mode:'original_text'}).processing_mode,'original_text');
 assert.equal(sourceProcessingOptions({generate_guide:false}).include_reading_guide,false);
});
test('RSS opt-in validates advertised feed, registers once and keeps existing subscription choices',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/site-rss-test-'),home=path.join(root,'subscriptions');
 await writeJson(paths(root).marker,{home});await writeJson(paths(root).config,{schema:SCHEMA,revision:1,enabled:true,subscriptions:[]});
 const source=normalizeSiteSource({url:'https://independent.example',name:'Independent',subscribe_rss:true,destination:'整站/Independent'});
 let reads=0;
 const fetchPage=async url=>{reads++;return {url,body:new URL(url).pathname==='/'?'<head><link rel="alternate" type="application/atom+xml" href="/feed.xml"></head>':'<feed xmlns="http://www.w3.org/2005/Atom"><title>Example</title><id>https://independent.example</id></feed>'};};
 assert.equal(await ensureSiteRss(root,{...source,subscribe_rss:false},{fetchPage}),null);assert.equal(reads,0);
 const first=await ensureSiteRss(root,source,{fetchPage});assert.equal(first.status,'created');
 const second=await ensureSiteRss(root,source,{fetchPage});assert.equal(second.subscription_id,first.subscription_id);assert.equal(second.status,'existing');
 const config=await loadConfig(root);assert.equal(config.subscriptions.length,1);assert.equal(config.subscriptions[0].mode,'standard_preprocess');assert.equal(config.subscriptions[0].generate_guide,false);
 await assert.rejects(ensureSiteRss(root,source,{fetchPage:async url=>({url,body:'<head></head>'})}),/未声明 RSS/u);
});
test('site form submits RSS checkbox and no-guide state through the same save endpoint',async()=>{
 const code=(await fs.readFile(new URL('../site-import/web/app.mjs',import.meta.url),'utf8')).replace("'/import/client.mjs'",JSON.stringify(pathToFileURL(path.resolve('scripts/browser-import-web/client.mjs')).href));
 const {mountImportCenter}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const dom=new JSDOM(await fs.readFile('site-import/web/index.html','utf8'),{url:'http://127.0.0.1/imports'});const doc=dom.window.document;let submitted;
 const mounted=mountImportCenter(doc,{pollMs:100000,fetchImpl:async(url,options)=>{
  if(url==='/api/site-imports/source'){submitted=JSON.parse(options.body);return Response.json({});}
  return Response.json(url==='/api/site-imports'?{revision:1,sources:[]}:url.endsWith('/history')?{requests:[],legacy_jobs:[]}:{});
 }});
 try{mounted.editor();doc.getElementById('site-url').value='https://fixture.example';doc.getElementById('site-rss').checked=true;
  assert.equal(doc.getElementById('site-mode').value,'standard_preprocess');assert.equal(doc.getElementById('site-guide').value,'false');
  doc.getElementById('site-form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
  for(let i=0;i<30&&!submitted;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(submitted.source.subscribe_rss,true);assert.equal(submitted.source.generate_guide,false);
  for(let i=0;i<50&&(!doc.getElementById('site-editor').hidden||doc.getElementById('site-save').disabled);i++)await new Promise(r=>setTimeout(r,10));
  await mounted.refresh();
 }finally{mounted.stop();dom.window.close();}
});
test('awaiting an overlapping initial refresh waits for the current revision to load',async()=>{
 const code=(await fs.readFile(new URL('../site-import/web/app.mjs',import.meta.url),'utf8')).replace("'/import/client.mjs'",JSON.stringify(pathToFileURL(path.resolve('scripts/browser-import-web/client.mjs')).href));
 const {mountImportCenter}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const dom=new JSDOM(await fs.readFile('site-import/web/index.html','utf8'),{url:'http://127.0.0.1/imports'});
 let finish;const delayed=new Promise(resolve=>{finish=resolve;});
 const mounted=mountImportCenter(dom.window.document,{pollMs:100000,fetchImpl:async url=>{
  if(url==='/api/site-imports'){await delayed;return Response.json({revision:23,sources:[]});}
  return Response.json({requests:[],legacy_jobs:[]});
 }});
 try{let settled=false;const current=mounted.refresh().then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);finish();await current;assert.match(dom.window.document.getElementById('site-health').textContent,/已连接/u);
 }finally{mounted.stop();dom.window.close();}
});
