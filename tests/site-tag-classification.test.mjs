import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {enumerateHtmlArchive} from '../site-import/html-archive.mjs';
import {articleTaxonomy,classifyExclusiveTags,taxonomyFolder} from '../site-import/taxonomy.mjs';
import {discoverSite,inventoryCurrent} from '../site-import/discovery.mjs';
import {normalizeSiteSource,runId} from '../site-import/store.mjs';
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
});
test('overlapping labels stay tags and explicit source hierarchy takes priority',()=>{
 const overlapping=[{taxonomy:articleTaxonomy({tags:['Topic','Focus']})},{taxonomy:articleTaxonomy({tags:['Topic']})}];assert.equal(classifyExclusiveTags(overlapping).exclusive,false);assert.equal(overlapping[1].taxonomy.primary.kind,'标签');
 const grouped=[{taxonomy:articleTaxonomy({categories:[['Original','Path']],tags:['Topic']})}];assert.equal(classifyExclusiveTags(grouped).exclusive,false);assert.deepEqual(grouped[0].taxonomy.primary.path,['Original','Path']);
 const partial=[{taxonomy:articleTaxonomy({tags:['One']})},{taxonomy:articleTaxonomy()}];assert.equal(classifyExclusiveTags(partial).exclusive,true);assert.equal(partial[1].taxonomy.primary.kind,'未分类');
});

test('the observed paginated homepage is valid archive evidence and keeps original category labels',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/homepage-archive-test-');
 const page=(slug,label,next='')=>'<article><h1><a href="/'+slug+'/">'+slug+'</a></h1><a href="/categories/example/">'+label+'</a></article>'+next;
 const fetchPage=async url=>{const p=new URL(url).pathname,body=p==='/'?page('first','Research •','<a class="next" href="/page/2/">Next</a>'):p==='/page/2/'?page('second','C++ •'):p==='/sitemap.xml'?'<urlset/>':p==='/robots.txt'?'':'<title>Original source</title><article><p>'+('Complete unchanged original source body. '.repeat(25))+'</p></article>';return {url,body,sha256:digest(body)};};
 const settings=normalizeSiteSource({url:base}),plan={include_paths:['/*'],exclude_paths:[],listing:{type:'html',url:base+'/',item_selector:'article h1 a',next_selector:'a.next'}};
 const inventory=await discoverSite(root,settings,runId('homepage-archive'),{fetchPage,planner:async()=>({plan,producer:{provider:'fixture'}})});
 assert.equal(inventory.complete,true);assert.equal(inventory.articles.length,2);assert.equal(inventory.tag_classification.exclusive,false);
 assert.deepEqual(inventory.articles.map(article=>article.taxonomy.primary.name),['Research','C++']);
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
