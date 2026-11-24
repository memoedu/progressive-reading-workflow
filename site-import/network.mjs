import { JSDOM } from 'jsdom';
import { unzipSync, gunzipSync } from 'node:zlib';
import { setTimeout as pause } from 'node:timers/promises';
import { htmlArticleToMarkdown } from '../scripts/browser-page-markdown.mjs';
import { htmlDetails } from '../scripts/url-background-fetch.mjs';
import { canonicalUrl, digest } from '../subscription-workflow/config.mjs';
import {articleTaxonomy,taxonomyFromJson} from './taxonomy.mjs';
import {pageBookResource} from './book-resources.mjs';
import {pageKind} from './page-kind.mjs';
export const CAPTURE_VERSION='site-body/v2';
const ARTICLE_HTML_LIMIT = 32 * 1024 * 1024;
const isMarkdownType = type => /^(?:text\/(?:x-)?markdown)(?:;|$)/iu.test(type||'');

export function sitePageUrl(value) {
  const pathname = new URL(value).pathname;
  const suffix = pathname.split('/').at(-1)?.match(/\.[a-z0-9_-]+$/iu)?.[0];
  return !suffix || /^\.(?:html?|xhtml|md|markdown|php|aspx?)$/iu.test(suffix);
}

export function scopedUrl(value,base) {
  const url=new URL(value,base),origin=new URL(base);
  if(process.env.NODE_ENV!=='test')canonicalUrl(url.href);
  if(url.origin!==origin.origin)throw new Error('站点发现地址超出当前网站：'+url.origin);
  url.hash='';return url.href;
}
export async function fetchSiteText(url,{base=url,fetchImpl=globalThis.fetch,maxBytes=6*1024*1024}={}) {
  let target=scopedUrl(url,base);
  for(let i=0;i<8;i++){
    const response=await fetchImpl(target,{headers:{'User-Agent':'Mozilla/5.0','Accept':'text/html,application/json,application/xml,text/xml,*/*'},redirect:'manual',signal:AbortSignal.timeout(45000)});
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location)throw new Error('站点跳转没有目标地址');
      const next=new URL(location,target);
      // A bare hostname commonly redirects to its www origin. Accept only that canonical alias.
      if(next.hostname.replace(/^www\./u,'')===new URL(base).hostname.replace(/^www\./u,'')&&next.protocol==='https:')base=next.origin;
      target=scopedUrl(next.href,base);continue;
    }
    if(!response.ok){await response.body?.cancel();const error=new Error('site_http_'+response.status);error.status=response.status;throw error;}
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw new Error('站点响应超过完整读取上限');chunks.push(chunk);}
    const body=Buffer.concat(chunks).toString('utf8');
    return {url:target,body,sha256:digest(body),bytes,content_type:response.headers.get('content-type') || ''};
  }
  throw new Error('站点跳转次数过多');
}
export function field(object,key) {
  if(!key || key==='$')return object;
  return key.split('.').reduce((value,part)=>value?.[part],object);
}
export function templateUrl(template,articleUrl,base,item=null) {
  const article=new URL(articleUrl);
  const url=String(template).replace(/\{(query\.[\w-]+|path(?:\.(?:last|\d+))?|item\.[\w.-]+)\}/gu,(_match,key)=>{
    const value=key==='path'?article.pathname:key.startsWith('path.')?article.pathname.split('/').filter(Boolean).at(key==='path.last'?-1:Number(key.slice(5))):key.startsWith('query.')?article.searchParams.get(key.slice(6)):field(item,key.slice(5));
    if(value===null || value===undefined)throw new Error('来源地址模板缺少字段：'+key);
    return encodeURIComponent(value);
  });
  if(/[{}]/u.test(url))throw new Error('来源地址模板含未识别占位符');
  return scopedUrl(url,base);
}
export function decodeBody(value,encoding='plain') {
  if(typeof value!=='string'||!value.trim())throw new Error('article_body_missing');
  if(encoding==='plain')return value;
  const data=Buffer.from(value,'base64');
  if(encoding==='base64')return data.toString('utf8');
  // Browser pako.inflate accepts both zlib and gzip wrappers; preserve that
  // behavior rather than confusing gzip-backed source text with missing content.
  if(encoding==='base64_deflate')return unzipSync(data,{maxOutputLength:8*1024*1024}).toString('utf8');
  if(encoding==='base64_gzip')return gunzipSync(data,{maxOutputLength:8*1024*1024}).toString('utf8');
  throw new Error('正文编码不支持');
}
export async function captureArticle(url,recipe,{fetchPage=fetchSiteText,fallbackHtml=false}={}) {
  const source=recipe?.type==='json' ? templateUrl(recipe.url_template,url,url) : url;
  const options = fallbackHtml && recipe?.type !== 'json' ? { base: url, maxBytes: ARTICLE_HTML_LIMIT } : { base: url };
  let response;
  for(let attempt=0;attempt<3;attempt++){
    try{
      response=await fetchPage(source,options);
      break;
    }
    catch(error){
      if(error.status===404||error.status===410)return {excluded:true,url,reason:'来源已下线',response_status:error.status};
      const transient=[408,429,500,502,503,504].includes(error.status)||error.name==='TimeoutError'||error.message==='fetch failed';
      if(!transient||attempt===2)throw error;
      await pause(1000*(attempt+1));
    }
  }
  let title='',markdown='',metadata={};
  const nativeMarkdown=isMarkdownType(response.content_type);
  if(recipe?.type!=='json'&&!nativeMarkdown){
    if(/^(?:image|video|audio)\/|^application\/(?:pdf|zip|octet-stream)(?:;|$)/iu.test(response.content_type||''))
      return {excluded:true,url,reason:'站点地址指向附件或媒体文件'};
    const resource=pageBookResource(response.body,response.url);if(resource)return {excluded:true,url,reason:resource.reason,resource};
    const kind=pageKind(response.body,response.url);if(kind.kind!=='article')return {excluded:true,url,...kind};
  }
  if(recipe?.type==='json'){
    const json=JSON.parse(response.body);
    if(recipe.private_path&&field(json,recipe.private_path)===true)return {excluded:true,url,reason:'来源标记为私密，未解码正文',response_sha256:response.sha256};
    if(recipe.status_path && recipe.success_values?.length && !recipe.success_values.map(String).includes(String(field(json,recipe.status_path)))){
      const message=String(field(json,recipe.message_path)||'');
      if(/不存在|未找到|已删除|not found|does not exist|deleted/iu.test(message))return {excluded:true,url,reason:message,response_sha256:response.sha256};
      throw new Error('来源接口未返回文章：'+message.slice(0,200));
    }
    if(recipe.identity_path&&recipe.identity_query){
      if(String(field(json,recipe.identity_path))!==new URL(url).searchParams.get(recipe.identity_query))throw new Error('article_source_identity_mismatch');
    }
    title=String(field(json,recipe.title_path)||'').trim();
    const body=decodeBody(field(json,recipe.content_path),recipe.encoding);
    markdown=recipe.content_format==='html'?htmlArticleToMarkdown({html:body,sourceUrl:url,title,extractArticle:false}).markdown:body;
    metadata={published_at:recipe.published_at_path?field(json,recipe.published_at_path):null,taxonomy:taxonomyFromJson(json,{collection_item_identity_path:recipe.identity_path?.split('.').at(-1),...recipe.taxonomy},field,recipe.identity_path?field(json,recipe.identity_path):null)};
  } else if(nativeMarkdown){
    markdown=response.body;
    title=/^title:\s*(.+)$/imu.exec(markdown)?.[1]?.replace(/^["']|["']$/gu,'')||/^#\s+(.+)$/mu.exec(markdown)?.[1]||new URL(url).pathname;
    metadata.taxonomy=articleTaxonomy({});
  } else {
    let html=response.body,selectedBody=false,declaredSource='',pageTitle='';
    const dom=new JSDOM(html,{url:response.url});
    try{
      const document=dom.window.document;
      pageTitle=document.title;
      const body=recipe?.body_selector?document.querySelector(recipe.body_selector):null;
      if(body){html=body.outerHTML;title=pageTitle;selectedBody=true;}
      const origin=new URL(response.url).origin;
      declaredSource=[...document.head.querySelectorAll('link[rel~="alternate"][type][href]')]
        .find(link=>isMarkdownType(link.type)&&URL.canParse(link.href)&&new URL(link.href).origin===origin&&link.href!==response.url)?.href||'';
      metadata.taxonomy=articleTaxonomy({categories:[...document.querySelectorAll('a[rel~=category],meta[property="article:section"]')].map(n=>n.content||n.textContent.trim()),tags:[...document.querySelectorAll('a[rel~=tag],meta[property="article:tag"]')].map(n=>n.content||n.textContent.trim())});
    }finally{dom.window.close();}
    if(declaredSource){
      const original=await fetchPage(declaredSource,{base:response.url,maxBytes:ARTICLE_HTML_LIMIT}).catch(()=>null);
      if(original&&isMarkdownType(original.content_type)&&original.body.trim()){
        response=original;
        markdown=original.body;
        title=pageTitle||new URL(url).pathname;
      }
    }
    if(!markdown){
      if(recipe?.body_selector&&!selectedBody){
        if(!fallbackHtml)throw new Error('站点指定的正文区域不存在');
        const {authReason,jsReason}=htmlDetails(html,response.url);
        if(authReason)throw new Error('来源需要登录：'+authReason);
        if(jsReason)throw new Error('来源未返回正文，需要浏览器渲染：'+jsReason);
      }
      const converted=htmlArticleToMarkdown({html,sourceUrl:url,title,extractArticle:!selectedBody});
      title=title || converted.title;markdown=converted.markdown;
      if(/^(?:loading[. …]*|正在加载[. …]*)$/iu.test(markdown.trim()) || markdown.replace(/\s/gu,'').length<20)throw new Error('网页未提供可核验正文，需要站点正文接口');
    }
  }
  if(!markdown.trim()||!title)throw new Error('来源缺少完整正文或文章标题');
  return {capture_version:CAPTURE_VERSION,url,title,markdown,source_response:{url:response.url,sha256:response.sha256,bytes:response.bytes,content_type:response.content_type},metadata};
}
