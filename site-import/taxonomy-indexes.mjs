import {JSDOM} from 'jsdom';
import {articleTaxonomy,mergeTaxonomies,taxonomyLabel} from './taxonomy.mjs';
import {urlImportDedupeKey} from '../scripts/url-import-input.mjs';
import {scopedUrl} from './network.mjs';

// A tag index is evidence of membership only for its actual listed entries,
// never for global navigation or arbitrary links inside an article body.
export async function taxonomyIndexes(links,articleUrls,base,fetchPage){
 const known=new Set(articleUrls.map(urlImportDedupeKey)),definitions=new Map(),memberships={},pages=[],hubs=new Set();
 const add=link=>{
  let url;try{url=new URL(link.url,base);if(url.origin!==new URL(base).origin)return;}catch{return;}
  const match=/(?:^|\/)(tags?|categor(?:y|ies))\/[^/]+/iu.exec(url.pathname),name=taxonomyLabel(link.title);
  if(match&&name&&name.length<=160)definitions.set(url.href,{url:url.href,name,kind:/^categor/iu.test(match[1])?'分类':'标签'});
  if(/\/(?:tags?|categories)\/?$/iu.test(url.pathname))hubs.add(url.href);
 };
 for(const link of links)add(link);
 // A taxonomy landing page can expose older classifications that never occur
 // on the homepage. Read its actual links, including heading-labelled cards.
 for(const url of hubs){
  const response=await fetchPage(url,{base}),dom=new JSDOM(response.body,{url:response.url});
  try{for(const anchor of dom.window.document.querySelectorAll('a[href]'))if(!anchor.closest('nav,footer,header,aside'))add({url:anchor.href,title:(anchor.querySelector('[itemprop=name],h2,h3,h4')||anchor).textContent});}
  finally{dom.window.close();}
  pages.push({kind:'taxonomy_hub',url:response.url,sha256:response.sha256,members:[]});
 }
 if(definitions.size>200)throw Error('分类目录超过完整核验上限，未将部分目录视为完整');
 let next=0;const list=[...definitions.values()];
 await Promise.all(Array.from({length:Math.min(4,list.length)},async()=>{while(next<list.length){
  const definition=list[next++],visited=new Set();let url=definition.url;
  while(url){
  if(visited.has(url)||visited.size>=1000)throw Error('分类目录分页重复或未结束，未将部分归属视为完整');visited.add(url);
  const response=await fetchPage(url,{base}),dom=new JSDOM(response.body,{url:response.url});
  try{
   const anchors=[...dom.window.document.querySelectorAll('article h1 a[href],article h2 a[href],article h3 a[href],main li a[href],[role=main] li a[href],body > ul > li a[href],.taxonomy .taxonomy__item a[href]')].filter(node=>!node.closest('nav,footer,header,aside'));
   const matched=[...new Set(anchors.map(anchor=>urlImportDedupeKey(anchor.href)).filter(url=>known.has(url)))];
   const taxonomy=articleTaxonomy(definition.kind==='分类'?{categories:[definition.name]}:{tags:[definition.name]});
   for(const url of matched){const prior=memberships[url]||{taxonomy:articleTaxonomy(),evidence:[]};memberships[url]={taxonomy:mergeTaxonomies(prior.taxonomy,taxonomy),evidence:[...prior.evidence,{kind:definition.kind,name:definition.name,url:response.url,sha256:response.sha256}]};}
   pages.push({...definition,url:response.url,index_url:definition.url,sha256:response.sha256,members:matched});
   const nextUrls=[...new Set([...dom.window.document.querySelectorAll('a[rel~=next][href],a.next[href]')].map(anchor=>scopedUrl(anchor.href,base)))];
   if(nextUrls.length>1)throw Error('分类目录存在多个下一页，无法核验完整归属');
   url=nextUrls[0]||null;
  }finally{dom.window.close();}
  }
 }}));
 // Parallel network completion must not choose an article's primary folder.
 const rank=new Map(list.map((definition,index)=>[definition.kind+'/'+definition.name,index]));
 for(const item of Object.values(memberships)){item.taxonomy.groups.sort((a,b)=>rank.get(a.kind+'/'+a.name)-rank.get(b.kind+'/'+b.name));item.taxonomy=mergeTaxonomies(item.taxonomy);}
 pages.sort((a,b)=>list.findIndex(d=>d.url===(a.index_url||a.url))-list.findIndex(d=>d.url===(b.index_url||b.url)));return {memberships,pages};
}
