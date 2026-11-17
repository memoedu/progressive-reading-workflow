import {JSDOM} from 'jsdom';
import {articleTaxonomy,mergeTaxonomies,taxonomyLabel} from './taxonomy.mjs';
import {urlImportDedupeKey} from '../scripts/url-import-input.mjs';

// A tag index is evidence of membership only for its actual listed entries,
// never for global navigation or arbitrary links inside an article body.
export async function taxonomyIndexes(links,articleUrls,base,fetchPage){
 const known=new Set(articleUrls.map(urlImportDedupeKey)),definitions=new Map(),memberships={},pages=[];
 for(const link of links){
  let url;try{url=new URL(link.url,base);if(url.origin!==new URL(base).origin)continue;}catch{continue;}
  const match=/(?:^|\/)(tags?|categor(?:y|ies))\/[^/]+/iu.exec(url.pathname),name=taxonomyLabel(link.title);
  if(match&&name&&name.length<=160)definitions.set(url.href,{url:url.href,name,kind:/^categor/iu.test(match[1])?'分类':'标签'});
 }
 if(definitions.size>200)throw Error('分类目录超过完整核验上限，未将部分目录视为完整');
 let next=0;const list=[...definitions.values()];
 await Promise.all(Array.from({length:Math.min(4,list.length)},async()=>{while(next<list.length){
  const definition=list[next++],response=await fetchPage(definition.url,{base}),dom=new JSDOM(response.body,{url:response.url});
  try{
   const anchors=[...dom.window.document.querySelectorAll('article h1 a[href],article h2 a[href],article h3 a[href],main li a[href],body > ul > li a[href]')].filter(node=>!node.closest('nav,footer'));
   const matched=[...new Set(anchors.map(anchor=>urlImportDedupeKey(anchor.href)).filter(url=>known.has(url)))];
   const taxonomy=articleTaxonomy(definition.kind==='分类'?{categories:[definition.name]}:{tags:[definition.name]});
   for(const url of matched){const prior=memberships[url]||{taxonomy:articleTaxonomy(),evidence:[]};memberships[url]={taxonomy:mergeTaxonomies(prior.taxonomy,taxonomy),evidence:[...prior.evidence,{kind:definition.kind,name:definition.name,url:response.url,sha256:response.sha256}]};}
   pages.push({...definition,sha256:response.sha256,members:matched});
  }finally{dom.window.close();}
 }}));
 // Parallel network completion must not choose an article's primary folder.
 const rank=new Map(list.map((definition,index)=>[definition.kind+'/'+definition.name,index]));
 for(const item of Object.values(memberships)){item.taxonomy.groups.sort((a,b)=>rank.get(a.kind+'/'+a.name)-rank.get(b.kind+'/'+b.name));item.taxonomy=mergeTaxonomies(item.taxonomy);}
 pages.sort((a,b)=>list.findIndex(d=>d.url===a.url)-list.findIndex(d=>d.url===b.url));return {memberships,pages};
}
