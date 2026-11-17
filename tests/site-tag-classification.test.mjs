import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {enumerateHtmlArchive} from '../site-import/html-archive.mjs';
import {articleTaxonomy,classifyExclusiveTags,taxonomyFolder,taxonomyGroups} from '../site-import/taxonomy.mjs';
import {discoverSite,inventoryCurrent} from '../site-import/discovery.mjs';
import {normalizeSiteSource,runId,runPath} from '../site-import/store.mjs';
import {capturedArticle} from '../site-import/tasks.mjs';
import {digest} from '../subscription-workflow/config.mjs';
import {taxonomyIndexes} from '../site-import/taxonomy-indexes.mjs';
import {urlImportDedupeKey} from '../scripts/url-import-input.mjs';
const base='https://independent-tags.example';
test('archive-only mutually exclusive labels become category folders with source evidence',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/exclusive-tags-test-');
 const archive='<nav><a href="/tag/not-a-membership/">All tags</a></nav><article><h2><a href="/first/">First</a></h2><p><a href="/tag/ideas/">Ideas</a></p></article><article><h2><a href="/second/">Second</a></h2><p><a href="/tag/methods/">Methods</a></p></article>';
 const fetchPage=async url=>{const p=new URL(url).pathname,body=p==='/'?'<a href="/posts/">All posts</a>':p==='/robots.txt'?'':p==='/sitemap.xml'?'<urlset/>':p==='/posts/'?archive:'<title>Written source</title><article><p>'+('Complete original source body. '.repeat(25))+'</p></article>';return {url,body,sha256:digest(body)};};
 const inventory=await discoverSite(root,normalizeSiteSource({url:base}),runId('archive-labels'),{fetchPage,planner:async()=>({plan:{include_paths:['/*'],exclude_paths:[],listing:{type:'html',url:base+'/posts/',item_selector:'article h2 a'}},producer:{provider:'fixture'}})});
 assert.equal(inventory.complete,true);assert.equal(inventory.tag_classification.exclusive,true);assert.equal(inventory.articles.length,2);
 assert.equal(taxonomyFolder('Site',inventory.articles[0].taxonomy),'Site/分类/Ideas');assert.equal(inventory.articles[1].taxonomy.primary.kind,'分类');assert.equal(inventory.articles[0].taxonomy.groups[0].source_kind,'标签');assert.equal(inventory.articles[0].taxonomy_evidence[0].url,base+'/tag/ideas/');
 assert.equal(inventory.articles.some(article=>article.taxonomy.groups.some(group=>group.name==='All tags')),false);
 assert.equal(inventoryCurrent(inventory,{}),true);assert.equal(inventoryCurrent({...inventory,discovery_version:'site-discovery/v1'},{}),false);
 const captureFile=runPath(root,inventory.article_source.run_id)+'/sources/'+digest(inventory.articles[0].url)+'.json',before=await fs.readFile(captureFile,'utf8');
 assert.equal((await capturedArticle(root,inventory.article_source,inventory.articles[0].url)).metadata.taxonomy.primary.name,'Ideas');
 assert.equal(await fs.readFile(captureFile,'utf8'),before);
});
test('overlapping labels stay tags and explicit source hierarchy takes priority',()=>{
 const overlapping=[{taxonomy:articleTaxonomy({tags:['Topic','Focus']})},{taxonomy:articleTaxonomy({tags:['Topic']})}];assert.equal(classifyExclusiveTags(overlapping).exclusive,false);assert.equal(overlapping[1].taxonomy.primary.kind,'标签');
 const grouped=[{taxonomy:articleTaxonomy({categories:[['Original','Path']],tags:['Topic']})}];assert.equal(classifyExclusiveTags(grouped).exclusive,false);assert.deepEqual(grouped[0].taxonomy.primary.path,['Original','Path']);
 const partial=[{taxonomy:articleTaxonomy({tags:['One']})},{taxonomy:articleTaxonomy()}];assert.equal(classifyExclusiveTags(partial).exclusive,true);assert.equal(partial[1].taxonomy.primary.kind,'未分类');
});

test('case aliases share one folder and never duplicate an article in its index',()=>{
 const one={url:base+'/first/',taxonomy:articleTaxonomy({categories:['Systems','systems']})},two={url:base+'/second/',taxonomy:articleTaxonomy({categories:['systems']})};
 const groups=taxonomyGroups([one,two]);assert.equal(groups.length,1);assert.deepEqual(groups[0].articles.map(article=>article.url),[one.url,two.url]);
 assert.equal(taxonomyGroups([{taxonomy:one.taxonomy},{taxonomy:one.taxonomy}])[0].articles.length,2);
});

test('the observed paginated homepage is valid archive evidence and keeps original category labels',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/homepage-archive-test-');
 const page=(slug,label,next='')=>'<article><h1><a href="/'+slug+'/">'+slug+'</a></h1><a href="/categories/example/">'+label+'</a></article>'+next;
 const fetchPage=async url=>{const p=new URL(url).pathname,body=p==='/'?page('first','Research •','<a class="next" href="/page/2/">Next</a>'):p==='/page/2/'?page('second','C++ •'):p==='/sitemap.xml'?'<urlset/>':p==='/robots.txt'?'':'<title>Original source</title><article><p>'+('Complete unchanged original source body. '.repeat(25))+'</p></article>';return {url,body,sha256:digest(body)};};
 const settings=normalizeSiteSource({url:base}),plan={include_paths:['/first/*'],exclude_paths:['/second/'],listing:{type:'html',url:base+'/',item_selector:'article h1 a',next_selector:'a.next'}};
 const inventory=await discoverSite(root,settings,runId('homepage-archive'),{fetchPage,planner:async()=>({plan,producer:{provider:'fixture'}})});
 assert.equal(inventory.complete,true);assert.equal(inventory.articles.length,2);assert.equal(inventory.tag_classification.exclusive,false);
 assert.deepEqual(inventory.articles.map(article=>article.taxonomy.primary.name),['Research','C++']);
 const scopedRoot=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/scoped-homepage-archive-test-');
 const scoped=await discoverSite(scopedRoot,normalizeSiteSource({url:base,exclude_paths:['/second/']}),runId('user-scope'),{fetchPage,planner:async()=>({plan,producer:{provider:'fixture'}})});
 assert.deepEqual(scoped.articles.map(article=>article.url),[base+'/first/']);
 const badRoot=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/unobserved-archive-test-');
 await assert.rejects(discoverSite(badRoot,settings,runId('unobserved-archive'),{fetchPage,planner:async()=>({plan:{...plan,listing:{...plan.listing,url:base+'/unobserved/'}},producer:{provider:'fixture'}})}),/缺少实际页面证据/u);
});
test('public tag-index membership is inverted without treating global navigation as membership',async()=>{
 const pages=new Map([
  ['/tags/first/','<nav><a href="/second/">Navigation</a></nav><ul><li><a href="/first/">First</a></li><li><a href="/second/">Second</a></li></ul>'],
  ['/tags/second/','<ul><li><a href="/second/">Second</a></li></ul>']
 ]);
 const result=await taxonomyIndexes([{url:base+'/tags/first/',title:'First tag'},{url:base+'/tags/second/',title:'Second tag'}],[base+'/first/',base+'/second/'],base,async url=>{if(url.endsWith('/first/'))await new Promise(r=>setTimeout(r,20));const body=pages.get(new URL(url).pathname);return {url,body,sha256:digest(body)};});
 assert.equal(result.memberships[urlImportDedupeKey(base+'/first/')].taxonomy.groups.length,1);assert.deepEqual(result.memberships[urlImportDedupeKey(base+'/second/')].taxonomy.groups.map(group=>group.name),['First tag','Second tag']);assert.equal(result.pages.length,2);
 const articles=Object.values(result.memberships).map(value=>({taxonomy:value.taxonomy}));assert.equal(classifyExclusiveTags(articles).exclusive,false);
});

test('taxonomy hubs expose heading-labelled categories and complete paginated index memberships',async()=>{
 const pages=new Map([
  ['/categories/','<a href="/categories/projects/"><h3>Projects</h3><span>18 posts</span></a><a href="/categories/practice/"><h2>Practice</h2><small>4 posts</small></a>'],
  ['/categories/projects/','<nav><a href="/navigation/">Navigation</a></nav><div class="taxonomy"><h1>Projects</h1><div class="taxonomy__item"><a href="/first/">First</a></div></div><a class="next" href="/categories/projects/page/2/">Next</a>'],
  ['/categories/projects/page/2/','<div class="taxonomy"><h1>Projects</h1><div class="taxonomy__item"><a href="/second/">Second</a></div></div>'],
  ['/categories/practice/','<main><h1>Practice</h1><ul><li><a href="/second/">Second</a></li></ul><article><p>A prose reference to <a href="/body-reference/">another article</a>.</p></article></main>']
 ]);
 const fetchPage=async url=>{const body=pages.get(new URL(url).pathname);assert.equal(typeof body,'string');return {url,body,sha256:digest(body)};};
 const result=await taxonomyIndexes([{url:base+'/categories/',title:'Categories'}],['first','second','navigation','body-reference'].map(slug=>base+'/'+slug+'/'),base,fetchPage);
 assert.deepEqual(result.memberships[urlImportDedupeKey(base+'/first/')].taxonomy.groups.map(g=>g.name),['Projects']);
 assert.deepEqual(result.memberships[urlImportDedupeKey(base+'/second/')].taxonomy.groups.map(g=>g.name),['Projects','Practice']);
 assert.equal(result.memberships[urlImportDedupeKey(base+'/navigation/')],undefined);assert.equal(result.memberships[urlImportDedupeKey(base+'/body-reference/')],undefined);
 assert.equal(result.pages.length,4);assert.equal(result.pages[0].kind,'taxonomy_hub');
 const looping=async url=>{const body='<main><ul><li><a href="/first/">First</a></li></ul></main><a rel="next" href="/categories/projects/">Next</a>';return {url,body,sha256:digest(body)};};
 await assert.rejects(taxonomyIndexes([{url:base+'/categories/projects/',title:'Projects'}],[base+'/first/'],base,looping),/分页重复/u);
});
