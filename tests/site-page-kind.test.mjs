import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {pageKind} from '../site-import/page-kind.mjs';
import {discoverSite} from '../site-import/discovery.mjs';
import {normalizeSiteSource,runId} from '../site-import/store.mjs';
import {digest} from '../subscription-workflow/config.mjs';
const base='https://separate-pages.example';
test('actual multipage contents expand while articles with chapter references remain articles',()=>{
 const links='<ol><li><a href="/interview/one.html">Part 1: first conversation</a></li><li><a href="/interview/two.html">Part 2: second conversation</a></li></ol>';
 assert.deepEqual(pageKind(links,base+'/interview/').subpages,[base+'/interview/one.html',base+'/interview/two.html']);
 assert.equal(pageKind('<article><p>'+('An essay with its own body. '.repeat(60))+'</p>'+links+'</article>',base+'/interview/').kind,'article');
 assert.equal(pageKind('<svg></svg><p>An animated visual.</p><script>requestAnimationFrame(draw)</script>',base+'/visual/').kind,'interactive');
 assert.equal(pageKind('<svg></svg><p>A short written article with an icon.</p>',base+'/essay/').kind,'article');
});
test('discovery follows all evidenced parts, avoids index publication and records unsupported visuals',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/site-parts-test-'),pages=new Map([
  ['/','<title>Author</title>'],['/robots.txt',''],['/sitemap.xml','<urlset><url><loc>'+base+'/interview/</loc></url><url><loc>'+base+'/visual/</loc></url></urlset>'],
  ['/interview/','<title>Interview</title><a href="/interview/one.html">Part 1: first conversation</a><a href="/interview/two.html">Part 2: second conversation</a>'],
  ['/interview/one.html','<title>First</title><article><p>'+('First complete source. '.repeat(30))+'</p></article>'],
  ['/interview/two.html','<title>Second</title><article><p>'+('Second complete source. '.repeat(30))+'</p></article>'],
  ['/visual/','<title>Animation</title><svg></svg><p>Animation</p><script>requestAnimationFrame(draw)</script>']
 ]);
 const fetchPage=async url=>{const body=pages.get(new URL(url).pathname);assert.notEqual(body,undefined,url);return {url,body,sha256:digest(body)};};
 const inventory=await discoverSite(root,normalizeSiteSource({url:base}),runId('complete-parts'),{fetchPage,planner:async()=>({plan:{include_paths:['/*'],exclude_paths:[]},producer:{provider:'fixture'}})});
 assert.equal(inventory.complete,true);assert.equal(inventory.articles.length,2);assert.equal(inventory.excluded.length,2);assert.equal(inventory.candidate_count,4);assert.equal(inventory.articles.some(a=>a.url===base+'/interview/'),false);
});
