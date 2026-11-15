import {JSDOM} from 'jsdom';
import {scopedUrl} from './network.mjs';
import {canonicalUrl} from '../subscription-workflow/config.mjs';

// Read only literal public JSON catalogs used by an explicitly linked library.
// Never execute site JavaScript or follow a book/PDF link to obtain a body.
export async function bookCatalogs(links,base,fetchPage){
 const libraries=links.filter(link=>/^(?:my |our |personal )?(?:library|bookshelf|book library|book catalog(?:ue)?)$|^(?:我的)?(?:书库|藏书|书架|图书目录)$/iu.test(link.title.trim()));
 const books=[],evidence=[];
 for(const link of libraries.slice(0,3)){
  const page=await fetchPage(scopedUrl(link.url,base),{base}),dom=new JSDOM(page.body,{url:page.url});
  let scripts;
  try{scripts=[...dom.window.document.querySelectorAll('script[src]')].map(node=>node.src).filter(url=>new URL(url).origin===new URL(base).origin).slice(0,4);}finally{dom.window.close();}
  const code=[];for(const url of scripts){const response=await fetchPage(url,{base});code.push(response.body);}
  const joined=code.join('\n');
  // A template is accepted only when the page's own rendering code proves it.
  const templates=[...joined.matchAll(/`(https?:\/\/[^`\s$]+)\$\{encodeURIComponent\(\w+\.([A-Za-z_$][\w$]*)\)\}([^`\s$]*)`/gu)].map(match=>({prefix:match[1],field:match[2],suffix:match[3]}));
  const jsonUrls=[...new Set([...joined.matchAll(/\bfetch\(\s*(['"])([^'"\s]+\.json(?:\?[^'"\s]*)?)\1/gu)].map(match=>scopedUrl(match[2],page.url)))];
  for(const url of jsonUrls.slice(0,3)){
   const response=await fetchPage(url,{base}),rows=JSON.parse(response.body);if(!Array.isArray(rows))continue;
   if(rows.length>20000)throw Error('书目目录超过完整核验上限');
   const template=templates.find(template=>rows.length&&rows.every(row=>typeof row?.[template.field]==='string'&&row[template.field]));
   const direct=rows.length&&rows.every(row=>typeof row?.url==='string')&&/\.url\b/u.test(joined);
   if(!template&&!direct)continue;
   let registered=0;
   for(const row of rows){
    const title=String(row.title||row.name||'').trim();if(!title)throw Error('书目目录缺少书名，未将部分目录视为完整');
    const target=canonicalUrl(direct?row.url:template.prefix+encodeURIComponent(row[template.field])+template.suffix);
    books.push({kind:'book',url:target,title:title.slice(0,500),author:String(row.author||'').slice(0,300),reason:'网站书库中的书目，仅登记链接，等待选择导入',evidence:{source_url:page.url,heading:link.title,catalog_url:url,catalog_sha256:response.sha256}});registered++;
   }
   evidence.push({source_url:page.url,catalog_url:url,sha256:response.sha256,declared:rows.length,registered});
  }
 }
 return {books,evidence};
}
