import path from 'node:path';
import {digest,readJson,writeJson} from './config.mjs';
import {materialKey} from './catalog.mjs';
import {includesPublication} from './history.mjs';
import {htmlArticleToMarkdown} from '../scripts/browser-page-markdown.mjs';

const hash=value=>digest(JSON.stringify(value));
const bodyFile=(home,cycle)=>path.join(home,'zhihu',cycle,'report-bodies.json');
const unsafeHtml=/<\s*(?:script|iframe|form|object|embed)\b|\b(?:access_token|sessionid|xsrf|authorization)=/iu;

export async function collectZhihuReportBodies(home,request) {
  const reports=path.join(path.dirname(home),'SubscriptionReportDrafts');
  const plan=await readJson(path.join(reports,'daily',request.cycle,'input.json'));
  if(plan?.revision!==request.revision || plan.cycle!==request.cycle || !plan.zhihuCheckpoint?.sources.length)return null;
  const known=new Set(plan.rssCheckpoint.knownKeys);
  const wanted=new Map(plan.zhihuCheckpoint.sources.filter(source=>source.mode==='reports' && source.kind==='zhihu_column' &&
    source.enabled && request.sources.includes(source.url)).map(source=>[source.url,{source,seen:new Set(source.seen),items:new Map()}]));
  return {
    observe(url,item){
      const group=wanted.get(url);
      if(!group)return;
      const {source,seen,items}=group, key=digest(materialKey(item.url));
      const backfill=['all','since'].includes(source.history_mode);
      if(known.has(key) || !includesPublication(source,item.published_at) || (!backfill && (!source.baseline_ready || seen.has(key))))return;
      const previous=items.get(item.key);
      if(previous?.conflict)return;
      if(previous && (previous.revision && item.revision && previous.revision!==item.revision ||
        previous.html && item.html && previous.html!==item.html)){
        items.set(item.key,{conflict:true});
      }else if(!previous || (item.revision && item.html)){
        items.set(item.key,item);
      }
    },
    async seal(sealed){
      const sources=[];
      for(const column of sealed.result.columns){
        const group=wanted.get(column.source_url);
        if(!group)continue;
        const rows=[];
        for(const item of column.materials){
          const row=group.items.get(item.key);
          if(!row)continue;
          let reason=null, markdown=null;
          if(row.conflict)reason='zhihu_report_article_body_conflict';
          else if(!item.revision || row.revision!==item.revision || row.url!==item.url)reason='zhihu_report_article_revision_changed';
          else if(!row.html)reason='zhihu_report_column_body_incomplete';
          else if(unsafeHtml.test(row.html))reason='zhihu_report_article_body_unverified';
          else {
            try {
              markdown=htmlArticleToMarkdown({html:row.html,sourceUrl:item.url,title:item.title}).markdown;
              if(!markdown.trim())reason='zhihu_report_column_body_incomplete';
            } catch {
              reason='zhihu_report_article_body_unverified';
            }
          }
          rows.push({key:item.key,url:item.url,revision:item.revision,...(reason ? {reason} : {markdown,bodySha256:digest(markdown),
            method:'zhihu_column_embedded_body'})});
        }
        sources.push({url:column.source_url,rows});
      }
      const body={cycle:request.cycle,revision:request.revision,captureSha256:sealed.sha256,sources};
      if(Buffer.byteLength(JSON.stringify(body))>12*1024*1024)return;
      await writeJson(bodyFile(home,request.cycle),{...body,sha256:hash(body)});
    }
  };
}

export async function readZhihuReportBodies(home,request,sealed){
  const saved=await readJson(bodyFile(home,request.cycle));
  if(!saved)return null;
  const {sha256,...body}=saved;
  if(hash(body)!==sha256 || body.cycle!==request.cycle || body.revision!==request.revision ||
    body.captureSha256!==sealed.sha256)throw Error('zhihu_report_body_capture_mismatch');
  return new Map(body.sources.map(source=>[source.url,new Map(source.rows.map(row=>[row.key,row]))]));
}
