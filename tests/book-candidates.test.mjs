import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {bookResources,pageBookResource} from '../site-import/book-resources.mjs';
import {readCandidates,registerCandidates,setCandidateStatus} from '../site-import/candidates.mjs';
import {discoverSite} from '../site-import/discovery.mjs';
import {normalizeSiteSource,runId} from '../site-import/store.mjs';
import {digest} from '../subscription-workflow/config.mjs';
import {mountCandidates} from '../site-import/web/candidates.mjs';
import {bookCatalogs} from '../site-import/book-catalogs.mjs';

const base='https://independent-books.example';
const temp=()=>fs.mkdtemp('D:/Artifacts/ProgressiveReading/book-candidates-test-');
test('linked library metadata uses only literal proven GET catalog and link templates, never book bodies',async()=>{
 const seen=[],pages=new Map([
  ['/shelf/view/','<script src="../common.js"></script><script src="./view.js"></script>'],
  ['/shelf/common.js',"async function load(){return fetch('../data.json').then(r=>r.json())}"],
  ['/shelf/view/view.js','const link=`https://publisher.example/book/${encodeURIComponent(entry.catalogId)}`;'],
  ['/shelf/data.json',JSON.stringify([{title:'Fixture book',author:'Author',catalogId:'a/b',pdf:'never-download.pdf'}])]
 ]);
 const result=await bookCatalogs([{url:base+'/shelf/view/',title:'My library'}],base,async url=>{seen.push(url);const body=pages.get(new URL(url).pathname);assert.notEqual(body,undefined,url);return {url,body,sha256:digest(body)};});
 assert.equal(result.books[0].url,'https://publisher.example/book/a%2Fb');assert.equal(result.books[0].author,'Author');assert.equal(result.evidence[0].registered,1);assert.equal(seen.length,4);assert.ok(seen.every(url=>new URL(url).origin===base));
});
test('explicit book sections and schema identify resources without treating book reviews as books',()=>{
 const html='<h1>Notebook</h1><a href="/book-review">Notes on a book</a><details><summary><h2>Books*</h2></summary><p>Digital editions too.</p></details><div><a href="https://publisher.example/title"><img alt="First Book"></a><a href="/textbook">Second<br>Book</a><a href="javascript:alert(1)">Ignore</a></div><h2>Essays</h2><a href="/essay">Essay about a book</a>';
 const books=bookResources(html,base);assert.deepEqual(books.map(b=>b.title),['First Book','Second Book']);assert.equal(books[1].url,base+'/textbook');
 assert.equal(pageBookResource('<title>Notes on a book</title><article>A review.</article>',base+'/review'),null);
 assert.equal(pageBookResource('<script type="application/ld+json">{"@graph":[{"@type":"Book","name":"Schema title"}]}</script>',base+'/book').title,'Schema title');
});

test('global candidates dedupe URLs, preserve origins and dismissed choices with revision guards',async()=>{
 const root=await temp(),resources=bookResources('<h2>Books</h2><a href="/book#one">A book</a>',base);
 await registerCandidates(root,resources,{source_id:'first',run_id:'one'});await registerCandidates(root,resources,{source_id:'first',run_id:'two'});
 let state=await readCandidates(root);assert.equal(state.items.length,1);assert.equal(state.items[0].sources.length,1);
 await setCandidateStatus(root,{id:state.items[0].id,status:'dismissed',revision:state.revision});
 await registerCandidates(root,resources,{source_id:'second',run_id:'three'});
 state=await readCandidates(root);assert.equal(state.items.length,1);assert.equal(state.items[0].sources.length,2);assert.equal(state.items[0].status,'dismissed');
 await assert.rejects(setCandidateStatus(root,{id:state.items[0].id,status:'pending',revision:0}),/已更新/u);
});

test('whole-site discovery never fetches explicitly listed book bodies and keeps review articles',async()=>{
 const root=await temp(),seen=[],pages=new Map([
  ['/', '<h1>Source</h1><h2>Books</h2><a href="/book">A digital book</a><a href="https://publisher.example/other">An external book</a><h2>Writing</h2>'],
  ['/robots.txt',''],['/sitemap.xml','<urlset>'+['book','review'].map(p=>'<url><loc>'+base+'/'+p+'</loc></url>').join('')+'</urlset>'],
  ['/review','<title>Notes on a book</title><article><h1>Notes on a book</h1><p>'+('This is a personal review, not the book. '.repeat(20))+'</p></article>']
 ]);
 const fetchPage=async url=>{seen.push(url);const body=pages.get(new URL(url).pathname);assert.notEqual(body,undefined,'Never fetch a book: '+url);return {url,body,sha256:digest(body)};};
 const inventory=await discoverSite(root,normalizeSiteSource({url:base}),runId('book-fixture'),{fetchPage,planner:async()=>({plan:{include_paths:['/*'],exclude_paths:[],article_source:{type:'html',body_selector:'article'}},producer:{provider:'fixture'}})});
 assert.equal(inventory.complete,true);assert.deepEqual(inventory.articles.map(a=>a.url),[base+'/review']);assert.equal(inventory.deferred_resources.length,2);assert.equal(seen.includes(base+'/book'),false);assert.equal(seen.some(u=>u.includes('publisher.example')),false);
 assert.equal((await readCandidates(root)).items.length,2);
});

test('candidate page shows metadata safely and status changes never start an import',async()=>{
 const dom=new JSDOM(await fs.readFile('site-import/web/candidates.html','utf8'),{url:'http://127.0.0.1/import-candidates'}),doc=dom.window.document,calls=[];
 const state={revision:1,items:[{id:'one',title:'<script>unsafe()</script>',kind:'book',url:base+'/book',status:'pending',reason:'Explicit book',sources:[{source_url:base,heading:'Books'}]}]};
 try{
  const app=mountCandidates(doc,{fetchImpl:async(url,options)=>{calls.push(url);if(options){const body=JSON.parse(options.body);assert.equal(body.status,'dismissed');state.items[0].status=body.status;state.revision++;}return Response.json(state);}});
  await app.refresh();assert.equal(doc.querySelector('#candidate-items script'),null);assert.match(doc.querySelector('h3').textContent,/unsafe/u);
  doc.querySelector('#candidate-items button').click();for(let i=0;i<20&&state.items[0].status==='pending';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(state.items[0].status,'dismissed');assert.ok(calls.every(url=>url.startsWith('/api/import-candidates')));
 }finally{dom.window.close();}
});
