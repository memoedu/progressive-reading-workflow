import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveEvidence,enumerateHtmlArchive} from '../site-import/html-archive.mjs';
const base='https://separate.example';
test('HTML archives follow declared redirects and all next pages without importing navigation or errors',async()=>{
 const responses=new Map([
  ['/all/','<meta http-equiv="refresh" content="0; url=/archives/">'],
  ['/archives/','<title>All posts</title><nav><a href="/error/">error</a></nav><article><h2><a href="/alpha/">Alpha</a></h2></article><a rel="next" href="/archives/page/2/">Next</a>'],
  ['/archives/page/2/','<article><h2><a href="/beta/">Beta</a></h2></article><footer><a href="/about/">About</a></footer>']
 ]);
 const fetchPage=async url=>{const body=responses.get(new URL(url).pathname);assert(body,url);return {url,body,sha256:'fixture'};};
 const evidence=await archiveEvidence([{url:base+'/all/',title:'all'}],base,fetchPage);
 assert.equal(evidence[0].url,base+'/archives/');
 const result=await enumerateHtmlArchive({url:evidence[0].url,item_selector:'article h2 a'},base,fetchPage);
 assert.deepEqual(result.urls,[base+'/alpha/',base+'/beta/']);assert.equal(result.pages.length,2);
 await assert.rejects(enumerateHtmlArchive({url:evidence[0].url,item_selector:'article'},base,fetchPage),/必须匹配文章链接/u);
});
test('HTML archive loops and cross-origin pages are incomplete',async()=>{
 const fetchPage=async url=>({url,body:'<article><a href="/alpha/">Alpha</a></article><a rel="next" href="/archives/">Next</a>'});
 await assert.rejects(enumerateHtmlArchive({url:base+'/archives/',item_selector:'article a'},base,fetchPage),/分页重复/u);
 await assert.rejects(enumerateHtmlArchive({url:base+'/archives/',item_selector:'article a'},base,async url=>({url,body:'<article><a href="https://other.example/alpha/">Other</a></article>'})),/超出当前网站/u);
});
