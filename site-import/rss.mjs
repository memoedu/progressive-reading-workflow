import {JSDOM} from 'jsdom';
import {canonicalUrl,loadConfig,saveSource} from '../subscription-workflow/config.mjs';
import {fetchSiteText} from './network.mjs';
import {parseFeedDocument} from '../rss-source/core.mjs';

const FEED_MAX_BYTES=12*1024*1024;

function advertisedFeeds(page){
  const dom=new JSDOM(page.body,{url:page.url});
  try{
    const document=dom.window.document;
    const links=[...document.querySelectorAll('link[rel~=alternate][href]')].filter(link=>/rss|atom/iu.test(link.type));
    const anchors=[...document.querySelectorAll('a[href]')].filter(link=>
      /rss|atom/iu.test(link.type)||/^\s*(?:rss|atom)(?:\s+feed)?\s*$/iu.test(link.textContent)||
      /^\/(?:rss|atom|feed)\.xml\/?$/iu.test(link.pathname));
    const candidates=new Set();
    for(const link of [...links,...anchors]){
      try{candidates.add(canonicalUrl(new URL(link.getAttribute('href'),page.url).href));}catch{/* Skip invalid links. */}
    }
    return [...candidates];
  }finally{dom.window.close();}
}

// Uses the existing subscription registry and scheduler. Never creates a second feed queue.
export async function ensureSiteRss(root,settings,{fetchPage=fetchSiteText}={}){
  if(!settings.subscribe_rss)return null;
  const page=await fetchPage(settings.url,{base:settings.url});
  const candidates=advertisedFeeds(page);
  if(!candidates.length)throw Error('网站未声明 RSS/Atom，可在订阅管理中填写已知的订阅地址');
  let feed,error;
  for(const url of candidates){try{
    const response=await fetchPage(url,{base:url,maxBytes:FEED_MAX_BYTES});
    await parseFeedDocument(response.body,response.url);
    feed=canonicalUrl(response.url);break;
  }catch(e){error=e;}}
  if(!feed)throw Error('RSS/Atom 验证失败：'+String(error?.message||'未找到可用订阅'));
  for(let attempt=0;attempt<3;attempt++){
    const config=await loadConfig(root);if(!config)throw Error('订阅系统尚未初始化');
    const existing=config.subscriptions.find(s=>s.kind==='rss'&&canonicalUrl(s.url)===feed);
    if(existing?.enabled)return {status:'existing',subscription_id:existing.id,url:feed};
    try{
      const next=await saveSource(root,existing?{id:existing.id,enabled:true}:{kind:'rss',name:settings.name,url:feed,
        mode:settings.processing_mode==='original_text'?'original_text':'standard_preprocess',destination:settings.destination,
        enabled:true,history_mode:'default',direct_reading:true,generate_guide:settings.generate_guide,translation_mode:settings.translation_mode},{expectedRevision:config.revision});
      const source=next.subscriptions.find(s=>s.kind==='rss'&&canonicalUrl(s.url)===feed);
      return {status:existing?'enabled':'created',subscription_id:source.id,url:feed};
    }catch(e){if(attempt===2||!/另一处更新|已经存在/u.test(e.message))throw e;}
  }
}
