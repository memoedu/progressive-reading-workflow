import {JSDOM} from 'jsdom';
import {scopedUrl} from './network.mjs';

export function pageKind(html,url){
 const dom=new JSDOM(html,{url});
 try{
  const doc=dom.window.document,script=[...doc.querySelectorAll('script')].map(node=>node.textContent).join('\n');
  if(/\/index(?:\.html?)?\/?$/iu.test(new URL(url).pathname)&&/\b(?:directory|tag index|category index)(?:\s*[·|–—].*)?$/iu.test(doc.title.trim()))
   return {kind:'navigation',reason:'来源页面是标签或文档目录'};
  for(const node of doc.querySelectorAll('script,style,nav,footer'))node.remove();
  const text=doc.body.textContent.replace(/\s+/gu,' ').trim();
  if(text.length<300&&doc.querySelector('svg,canvas')&&/requestAnimationFrame|\.getContext\(/u.test(script))return {kind:'interactive',reason:'主要内容为交互图像或动画，没有可完整导入的文章正文'};
  const parent=new URL('.',url).pathname;
  const anchors=[...doc.querySelectorAll('a[href]')].filter(anchor=>{try{const link=new URL(anchor.href);return link.origin===new URL(url).origin&&link.pathname.startsWith(parent)&&link.href.split('#')[0]!==url.split('#')[0]&&!link.hash&&!/\.(?:pdf|png|jpe?g|gif|svg|zip|mp[34]|json)$/iu.test(link.pathname);}catch{return false;}});
  const chapters=anchors.filter(anchor=>/^(?:part|chapter|section)\s*\d+\b|^第.{1,8}[章篇部分节]/iu.test(anchor.textContent.replace(/\s+/gu,' ').trim()));
  const linked=anchors.reduce((sum,anchor)=>sum+anchor.textContent.replace(/\s+/gu,' ').trim().length,0);
  if(chapters.length>=2&&linked>text.length*.6)return {kind:'collection',title:doc.title||doc.querySelector('h1')?.textContent?.trim()||new URL(url).pathname,reason:'分篇正文目录，继续核对分篇内容，目录本身不作为正文入库',subpages:[...new Set(anchors.map(anchor=>scopedUrl(anchor.href,url)))]};
  return {kind:'article'};
 }finally{dom.window.close();}
}
