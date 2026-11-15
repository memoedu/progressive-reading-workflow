import {JSDOM} from 'jsdom';
import {scopedUrl} from './network.mjs';

export async function archivePage(url,base,fetchPage){
 const visited=new Set();
 while(!visited.has(url)&&visited.size<5){
  visited.add(url);const response=await fetchPage(url,{base});const dom=new JSDOM(response.body,{url:response.url});
  try{
   const redirect=[...dom.window.document.querySelectorAll('meta[http-equiv]')].find(n=>n.httpEquiv.toLowerCase()==='refresh');
   const target=redirect&&/;\s*url\s*=\s*["']?([^"']+)/iu.exec(redirect.content)?.[1]?.trim();
   if(target){url=scopedUrl(target,response.url);continue;}
   return response;
  }finally{dom.window.close();}
 }
 throw Error('文章归档跳转未结束');
}

export async function archiveEvidence(links,base,fetchPage){
 const candidates=links.filter(l=>/^(?:all|all posts|archives?|posts|全部文章|所有文章|文章归档|归档)$/iu.test(l.title.trim())||/\/(?:archives?|posts|all)\/?$/iu.test(new URL(l.url).pathname));
 const result=[];
 for(const item of candidates.slice(0,3)){
  const response=await archivePage(item.url,base,fetchPage);
  if(result.some(p=>p.url===response.url))continue;
  const dom=new JSDOM(response.body,{url:response.url});
  try{result.push({url:response.url,sha256:response.sha256,title:dom.window.document.title,
   html_excerpt:response.body.slice(0,22000),links:[...dom.window.document.querySelectorAll('a[href]')].map(a=>({url:a.href,title:a.textContent.trim()})).filter(l=>new URL(l.url).origin===new URL(base).origin)});}finally{dom.window.close();}
 }
 return result;
}

export async function enumerateHtmlArchive(listing,base,fetchPage){
 if(typeof listing.item_selector!=='string'||!listing.item_selector.trim())throw Error('HTML 文章归档缺少可验证的链接选择器');
 let url=scopedUrl(listing.url,base);const pages=[],urls=[],visited=new Set();
 while(url){
  if(visited.has(url)||visited.size>=1000)throw Error('文章归档分页重复或未结束，未将部分目录视为全集');
  visited.add(url);const response=await archivePage(url,base,fetchPage);const dom=new JSDOM(response.body,{url:response.url});
  try{
   const nodes=[...dom.window.document.querySelectorAll(listing.item_selector)];
   if(!nodes.length)throw Error('文章归档选择器未匹配任何文章');
   if(nodes.some(n=>n.localName!=='a'||!n.getAttribute('href')))throw Error('文章归档选择器必须匹配文章链接');
   const batch=nodes.map(n=>scopedUrl(n.getAttribute('href'),response.url));
   if(batch.some(u=>urls.includes(u))&&batch.every(u=>urls.includes(u)))throw Error('文章归档分页重复');
   urls.push(...batch);pages.push({url:response.url,sha256:response.sha256,count:batch.length});
   const next=[...dom.window.document.querySelectorAll(listing.next_selector||'a[rel~=next]')].map(a=>scopedUrl(a.getAttribute('href'),response.url));
   if(new Set(next).size>1)throw Error('文章归档存在多个下一页，无法核验完整分页');
   url=next[0]||null;
  }finally{dom.window.close();}
 }
 return {urls:[...new Set(urls)],pages};
}
