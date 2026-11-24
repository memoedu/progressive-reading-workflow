import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync,gzipSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';
import { decodeBody,templateUrl,captureArticle } from '../site-import/network.mjs';
import { discoverSite,matchesPath,scriptEvidence } from '../site-import/discovery.mjs';
import { normalizeSiteSource,saveSiteSource,runId,readSources } from '../site-import/store.mjs';
import { digest } from '../subscription-workflow/config.mjs';
import { processCollectionTask } from '../scripts/collection-import.mjs';

const base='https://independent.example';
const body='# 原始材料\n\n保留中文、公式 $a^2+b^2$、链接与代码。\n\n```js\nconst source = 1;\n```\n';
const temp=()=>fs.mkdtemp('D:/Artifacts/ProgressiveReading/site-test-');

test('article discovery can read large HTML archives within a separate bounded body limit',async()=>{
  const html='<html><head><title>Long archive</title></head><body><article><h1>Original</h1><p>This document contains the complete evidence for the independently published historical article.</p></article></body></html>';
  const url=base+'/archived-article.html';
  const size=15*1024*1024;
  const fetchPage=async(requested,options)=>{
    assert.equal(requested,url);
    if((options.maxBytes||0)<size)throw new Error('站点响应超过完整读取上限');
    assert.ok(options.maxBytes<=32*1024*1024);
    return {url,body:html,sha256:digest(html),bytes:size,content_type:'text/html'};
  };
  const captured=await captureArticle(url,{type:'html',body_selector:'article'},{fetchPage,fallbackHtml:true});
  assert.match(captured.markdown,/complete evidence/u);
  assert.equal(captured.source_response.bytes,size);
});
test('encoded source decoding, query/path templates and scope are generic',()=>{
  for(const [encoding,value]of [['base64_deflate',deflateSync(body)],['base64_gzip',gzipSync(body)],['base64',Buffer.from(body)]])assert.equal(decodeBody(value.toString('base64'),encoding),body);
  assert.equal(decodeBody(gzipSync(body).toString('base64'),'base64_deflate'),body);
  assert.equal(templateUrl('/read/{path.last}','https://independent.example/posts/alpha',base),base+'/read/alpha');
  assert.equal(templateUrl('/read?id={query.id}',base+'/posts?id=0',base),base+'/read?id=0');
  assert.equal(matchesPath(base+'/blog/article?seq=0',['/blog/article?seq=*']),true);
  assert.throws(()=>templateUrl('https://other.example/read',base,base),/超出/u);
  assert.throws(()=>normalizeSiteSource({url:base,name:'a',destination:'../escape'}));
});
test('adjacent minified API literals are each preserved as complete evidence',()=>{
  const snippet='const list=e=>client({url:"/entries/list",method:"GET",params:{size:e}}),read=e=>client({url:"/entries/fetch-original-by-slug",method:"GET",params:{slug:e}});';
  assert.ok(scriptEvidence(snippet).some(value=>value.includes('/entries/fetch-original-by-slug')));
  const many=Array.from({length:90},(_,i)=>`const article${i}=client({url:"/article/${i}",method:"GET"});`).join('');
  assert.ok(scriptEvidence(many+'function FETCHARTICLE(e,t){e.articleTitle=t.heading;const a=atob(t.payload);e.articleContent=inflate(a)}').some(value=>value.includes('atob(t.payload)')));
});
test('optimistic settings preserve source IDs and explicit false',async()=>{
  const root=await temp(),first=await saveSiteSource(root,{url:base,name:'Source',processing_mode:'original_text',generate_index:false},0);
  await assert.rejects(saveSiteSource(root,{id:first.source.id,url:base,name:'Other'},0),/另一处/u);
  const next=await saveSiteSource(root,{id:first.source.id,instruction:'only posts'},1);
  assert.equal(next.source.processing_mode,'original_text');assert.equal(next.source.generate_index,false);
  assert.equal((await readSources(root)).sources.length,1);
});
test('complete public API beats stale sitemap; failed capture resumes and private bodies are never fetched',async()=>{
  const root=await temp(),id=runId('test-retry'),hits=[];let recovered=false;
  const plan={include_paths:['/posts/*'],exclude_paths:[],article_source:{type:'json',url_template:base+'/read/{path.last}',title_path:'entry.heading',content_path:'entry.payload',encoding:'base64_gzip',content_format:'markdown',private_path:'entry.secret'},listing:{url:base+'/catalog?size=1',total_path:'total',items_path:'entries',item_url_template:base+'/posts/{item.slug}',private_path:'secret',limit_parameter:'size'}};
  const fetchPage=async url=>{hits.push(url);const u=new URL(url);let value;
    if(u.pathname==='/')value='<title>Source</title><script src="/main.js"></script>';
    else if(u.pathname==='/robots.txt')value='';
    else if(u.pathname==='/sitemap.xml')value='<urlset><url><loc>'+base+'/posts/alpha</loc></url></urlset>';
    else if(u.pathname==='/main.js')value='const url:"/read/"; const articleContent="payload"; const url:"/catalog";';
    else if(u.pathname==='/catalog')value=JSON.stringify({total:3,entries:[{slug:'alpha'},{slug:'beta'},{slug:'private',secret:true}].slice(0,Number(u.searchParams.get('size')))});
    else if(u.pathname==='/read/beta'&&!recovered)throw new Error('synthetic_network_failure');
    else if(u.pathname.startsWith('/read/'))value=JSON.stringify({entry:{heading:u.pathname,payload:gzipSync(body).toString('base64')}});
    else throw new Error('unexpected:'+url);
    return {url,body:value,sha256:digest(value),bytes:Buffer.byteLength(value)};
  };
  // Evidence contains the literal endpoint prefix, independent from any real source.
  plan.article_source.url_template=base+'/read/?slug={path.last}';
  const wrapped=async(url,options)=>{if(url.includes('/read/?slug='))return fetchPage(base+'/read/'+new URL(url).searchParams.get('slug'),options);return fetchPage(url,options);};
  const settings=normalizeSiteSource({url:base,name:'Synthetic',processing_mode:'original_text'}),planner=async()=>({plan,producer:{provider:'fixture',completed:true}});
  await assert.rejects(discoverSite(root,settings,id,{planner,fetchPage:wrapped}),/已核实 1 篇，排除 1 项/u);
  recovered=true;const inventory=await discoverSite(root,settings,id,{planner,fetchPage:wrapped});
  assert.equal(inventory.complete,true);assert.equal(inventory.articles.length,2);assert.equal(inventory.excluded_count,1);assert.equal(inventory.declared_total,3);
  assert.equal(hits.filter(url=>url.endsWith('/read/alpha')).length,1);assert.equal(hits.some(url=>url.endsWith('/read/private')),false);
});
test('collection resume preserves batch membership after prior results were saved',async()=>{
  const urls=Array.from({length:52},(_,i)=>base+'/p/'+i),row=url=>({requested_url:url,status:'imported'}),calls=[];
  const collection={phase:'importing',inventory:{complete:true,articles:urls.map(url=>({url}))},results:urls.slice(0,50).map(row),batches:[{request_id:'first',terminal:true}]};
  const task={id:'parent',requested_url:base,collection};
  const broker={updateTaskProgress:async()=>{},getRequest:async()=>null,createRequest:async submitted=>{calls.push(submitted);return {request_id:'second'};},completeTask:async(_id,{ok})=>assert.equal(ok,true)};
  broker.getRequest=async id=>({request_id:id,terminal:true,results:urls.slice(50).map(row)});
  await processCollectionTask(task,{broker,runRequest:async()=>{},pollMs:1});
  assert.deepEqual(calls,[urls.slice(50)]);assert.equal(collection.results.length,52);
});
test('collection polling checkpoints only when the child request changes',async()=>{
  const url=base+'/article';
  const working={updated_at:'first',status:'processing',terminal:false,results:[{requested_url:url,status:'claimed'}]};
  const done={updated_at:'second',status:'completed',terminal:true,results:[{requested_url:url,status:'imported'}]};
  const polls=[working,working,working,done];
  let writes=0;
  const broker={
    createRequest:async()=>({request_id:'child'}),getRequest:async()=>polls.shift(),
    updateTaskProgress:async()=>{writes++;},completeTask:async(_id,{ok})=>assert.equal(ok,true)
  };
  const task={id:'parent',requested_url:base,collection:{phase:'importing',inventory:{complete:true,articles:[{url}]},batches:[],results:[]}};
  await processCollectionTask(task,{broker,runRequest:async()=>{},pollMs:1});
  assert.equal(writes,4);
  assert.deepEqual(task.collection.results,done.results);
});
test('all-page scope complements featured links with sitemap pages and reuses indexed Markdown', async()=>{
  const root=await temp(),hits=[];
  const featured=base+'/featured',unlisted=base+'/another.md',attachment=base+'/archive.pdf';
  const fetchPage=async url=>{
    hits.push(url);
    const pages={
      [base+'/']:'<ul class="featured"><li><a href="/featured">Featured</a></li></ul>',
      [base+'/robots.txt']:'',
      [base+'/sitemap.xml']:'<urlset>'+[featured,unlisted,attachment].map(url=>'<url><loc>'+url+'</loc></url>').join('')+'</urlset>',
      [unlisted]:body
    };
    assert.ok(Object.hasOwn(pages,url),'unexpected fetch: '+url);
    return {url,body:pages[url],sha256:digest(pages[url]),content_type:url===unlisted?'text/markdown':'text/html'};
  };
  const planner=async()=>({plan:{include_paths:['/*'],listing:{type:'html',url:base+'/',item_selector:'.featured a'}}});
  const settings=normalizeSiteSource({url:base,scope:'content',processing_mode:'original_text'});
  const tree='a'.repeat(40),commit='b'.repeat(40);
  const inventory=await discoverSite(root,settings,runId('full-site-fixture'),{planner,fetchPage,
    lookupSharedIndex:async()=>({tree,keys:new Set([digest(featured)])}),
    lookupSharedArticle:async(_root,url,_prior,{lookupOnly})=>{
      assert.equal(url,featured);assert.equal(lookupOnly,true);
      return {status:'available',commit,path:'Fixtures/article.md',sha256:digest(body),article:{title:'Original from GitHub',markdown:body}};
    }
  });
  assert.equal(inventory.complete,true);
  assert.deepEqual(inventory.articles.map(row=>row.url),[featured,unlisted]);
  assert.equal(inventory.shared_library.tree,tree);
  assert.equal(hits.includes(featured),false);
  assert.equal(hits.includes(attachment),false);
  assert.equal(inventory.articles[1].markdown_sha256,digest(body));
});
test('an HTML archive preserves articles with different body layouts',async()=>{
  const root=await temp(),id=runId('mixed-layout-archive');
  const first=base+'/entries/usual',second=base+'/entries/older.html';
  const original='这里是旧版页面完整可读的正文，归档条目应保留这一段内容。';
  const pages={
    [base+'/']:'<title>Archive</title><ul class="archive"><li><a href="/entries/usual">Usual</a></li><li><a href="/entries/older.html">Older</a></li></ul>',
    [base+'/robots.txt']:'', [base+'/sitemap.xml']:'<urlset/>',
    [first]:'<title>Usual</title><article id="regular"><p>这里是具有站点通用正文选择器的可读内容。</p></article>',
    [second]:'<title>Older</title><article><p>'+original+'</p></article>'
  };
  const fetchPage=async url=>{
    assert.ok(Object.hasOwn(pages,url),url);
    return {url,body:pages[url],sha256:digest(pages[url]),content_type:'text/html'};
  };
  const plan={include_paths:['/*'],article_source:{type:'html',body_selector:'#regular'},
    listing:{type:'html',url:base+'/',item_selector:'.archive a'}};
  const settings=normalizeSiteSource({url:base,scope:'blog',processing_mode:'original_text'});
  const inventory=await discoverSite(root,settings,id,{planner:async()=>({plan}),fetchPage});
  assert.equal(inventory.complete,true);
  assert.deepEqual(inventory.articles.map(row=>row.url),[first,second]);
  assert.equal(inventory.excluded_count,0);
  const capture=await captureArticle(second,plan.article_source,{fetchPage,fallbackHtml:true});
  assert.match(capture.markdown,new RegExp(original,'u'));
});

test('mixed-layout fallback still rejects login forms and JavaScript shells',async()=>{
  const url=base+'/other-layout';
  for(const [body,error]of [
    ['<title>Login</title><form action="/login"><input type="password"><p>Sign in to continue reading this article.</p></form>',/来源需要登录/u],
    ['<title>Loading</title><div id="app"></div><script src="/bundle.js"></script><noscript>Please enable JavaScript.</noscript>',/需要浏览器渲染/u]
  ]){
    const fetchPage=async()=>({url,body,sha256:digest(body),content_type:'text/html'});
    await assert.rejects(captureArticle(url,{type:'html',body_selector:'#regular'},{fetchPage,fallbackHtml:true}),error);
  }
});

test('site retry preserves its original candidates after the archive and sitemap expand',async()=>{
  const root=await temp(),id=runId('protected-retry-scope');
  const saved=base+'/archive/saved',missing=base+'/archive/missing',later=base+'/archive/new';
  const hits=[];
  let expanded=false;
  const article='<title>Source</title><article><p>这是可完整提取的原始文章正文，任务重试应该继续使用先前已核验的内容。</p></article>';
  const fetchPage=async url=>{
    hits.push(url);
    const urls=[saved,missing,...(expanded?[later]:[])];
    const pages={
      [base+'/']:'<title>Archive</title><ul class="archive">'+urls.map(url=>'<li><a href="'+url+'">Entry</a></li>').join('')+'</ul>',
      [base+'/robots.txt']:'', [base+'/sitemap.xml']:'<urlset>'+urls.map(url=>'<url><loc>'+url+'</loc></url>').join('')+'</urlset>',
      [saved]:article, [missing]:article, [later]:article
    };
    if(url===missing&&!expanded)throw new Error('fixture_extraction_error');
    assert.ok(Object.hasOwn(pages,url),url);
    return {url,body:pages[url],sha256:digest(pages[url]),content_type:'text/html'};
  };
  const plan={include_paths:['/*'],listing:{type:'html',url:base+'/',item_selector:'.archive a'}};
  const settings=normalizeSiteSource({url:base,scope:'content',processing_mode:'original_text'});
  let snapshot;
  await assert.rejects(discoverSite(root,settings,id,{planner:async()=>({plan}),fetchPage}),error=>{
    snapshot=error.inventory;
    return snapshot?.candidate_count===2&&snapshot.failures.length===1;
  });
  expanded=true;
  const result=await discoverSite(root,settings,id,{retryInventory:snapshot,fetchPage,planner:async()=>assert.fail('retry replanned the site')});
  assert.equal(result.complete,true);
  assert.deepEqual(result.articles.map(row=>row.url),[saved,missing]);
  assert.equal(hits.includes(later),false);
  assert.equal(hits.filter(url=>url===saved).length,1);
});
test('new page preserves source editor, original settings, failures, and existing learning payload',async()=>{
  const html=await fs.readFile(new URL('../site-import/web/index.html',import.meta.url),'utf8');
  const code=(await fs.readFile(new URL('../site-import/web/app.mjs',import.meta.url),'utf8')).replace("'/import/client.mjs'",JSON.stringify(pathToFileURL(path.resolve('scripts/browser-import-web/client.mjs')).href));
  const {mountImportCenter}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  const dom=new JSDOM(html,{url:'http://127.0.0.1/imports'}),doc=dom.window.document,calls=[];
  let source,revision=0;
  const mounted=mountImportCenter(doc,{pollMs:100000,fetchImpl:async(url,options)=>{
    const data=options?.body?JSON.parse(options.body):null;calls.push({url,data});let result;
    if(url==='/api/site-imports')result={revision,sources:source?[source]:[],runs:[]};
    else if(url.endsWith('/source')){source={id:'synthetic',...data.source};revision++;result={source,revision};}
    else if(url.endsWith('/history'))result={requests:[],legacy_jobs:[]};
    else if(url==='/api/learning/projects')result={manifest:{id:'learning',title:'Example'}};
    else throw new Error('synthetic unavailable');
    return new Response(JSON.stringify(result));
  }});
  try{
    await new Promise(r=>setTimeout(r,20));doc.getElementById('site-add').click();
    doc.getElementById('site-url').value=base;doc.getElementById('site-name').value='Independent';doc.getElementById('site-mode').value='original_text';doc.getElementById('site-mode').dispatchEvent(new dom.window.Event('change'));
    assert.equal(doc.querySelector('[data-site-standard]').hidden,true);
    doc.getElementById('site-form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,30));
    assert.equal(source.processing_mode,'original_text');assert.equal(source.destination,'整站/Independent');assert.match(doc.getElementById('site-sources').textContent,/原文直接入库/u);
    doc.getElementById('learningRepo').value='https://github.com/example/source';doc.getElementById('learningCreate').click();await new Promise(r=>setTimeout(r,20));
    assert.equal(calls.find(c=>c.url==='/api/learning/projects').data.repoUrl,'https://github.com/example/source');
  }finally{mounted.stop();dom.window.close();}
});
