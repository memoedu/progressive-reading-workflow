import {JSDOM} from 'jsdom';
import {urlImportDedupeKey} from '../scripts/url-import-input.mjs';

const clean=value=>String(value||'').replace(/\s+/gu,' ').trim();
const bookHeading=value=>/^(?:(?:my|our|selected|digital|online|published|recommended)\s+)*(?:books?|textbooks?|e-?books?)(?:\s*(?:and|&)\s*digital books)?[\s*✱＊:：]*$|^(?:我的|出版|推荐|在线|数字)?(?:书籍|著作|图书|电子书)[\s:：]*$/iu.test(clean(value));
function resource(anchor,source,heading){
 let url;try{url=new URL(anchor.getAttribute('href'),source).href;if(!/^https?:/u.test(url))return null;}catch{return null;}
 const copy=anchor.cloneNode(true);for(const br of copy.querySelectorAll('br'))br.replaceWith(' ');
 const title=clean(anchor.getAttribute('aria-label')||anchor.getAttribute('title')||anchor.querySelector('[itemprop=name]')?.textContent||anchor.querySelector('img[alt]')?.getAttribute('alt')||copy.textContent);
 if(!title)return null;
 return {kind:'book',url,title:title.slice(0,500),reason:'网站明确列为书籍，仅登记链接，等待选择导入',evidence:{source_url:source,heading:clean(heading)}};
}

// Only explicit publisher/author book sections are authoritative. A review
// mentioning a book in its prose or title is still an ordinary article.
export function bookResources(html,source){
 const dom=new JSDOM(html,{url:source}),items=[];let section=null;
 try{
  for(const node of dom.window.document.querySelectorAll('h1,h2,h3,h4,h5,h6,a[href]')){
   if(/^h[1-6]$/u.test(node.localName)){
    const level=Number(node.localName[1]);
    if(section&&level<=section.level)section=null;
    if(bookHeading(node.textContent))section={level,heading:node.textContent};
   }else if(section){const item=resource(node,source,section.heading);if(item)items.push(item);}
  }
  for(const node of dom.window.document.querySelectorAll('[itemscope][itemtype]')){
   if(!/(?:^|\s)https?:\/\/schema\.org\/Book(?:\s|$)/u.test(node.getAttribute('itemtype')))continue;
   const anchor=node.matches('a[href]')?node:node.querySelector('a[itemprop=url][href]');
   if(anchor){const item=resource(anchor,source,'schema.org/Book');if(item)items.push(item);}
  }
  return [...new Map(items.map(item=>[urlImportDedupeKey(item.url),item])).values()];
 }finally{dom.window.close();}
}

export function pageBookResource(html,url){
 const dom=new JSDOM(html,{url});
 try{
  for(const script of dom.window.document.querySelectorAll('script[type="application/ld+json"]')){
   let value;try{value=JSON.parse(script.textContent);}catch{continue;}
   const entries=[].concat(value?.['@graph']||value);
   for(const entry of entries)if([].concat(entry?.['@type']||[]).includes('Book'))return {kind:'book',url,title:clean(entry.name||dom.window.document.title),reason:'页面结构化数据标记为书籍，等待选择导入',evidence:{source_url:url,heading:'schema.org/Book'}};
  }
  const node=dom.window.document.querySelector('[itemscope][itemtype$="/Book"]');
  return node?{kind:'book',url,title:clean(node.querySelector('[itemprop=name]')?.textContent||dom.window.document.title),reason:'页面结构化数据标记为书籍，等待选择导入',evidence:{source_url:url,heading:'schema.org/Book'}}:null;
 }finally{dom.window.close();}
}
