import fs from 'node:fs/promises';
import path from 'node:path';
import {digest,readJson,withLock,writeJson} from './config.mjs';
import {materialKey,saveSourceMaterial} from './catalog.mjs';
import {meaningfulLength} from './content-length.mjs';
import {includesPublication} from './history.mjs';
import {readSealedDiscovery} from './remote-discovery-capture.mjs';
import {readNativeZhihuReportBodies,verifyZhihuDiscovery} from './zhihu-discovery-stage.mjs';
import {htmlArticleToMarkdown} from '../scripts/browser-page-markdown.mjs';
import {LONG_THRESHOLD,prepareIsolatedReportPreview} from '../rss-reading/core.mjs';

const hash=value=>digest(JSON.stringify(value));
const localDate=instant=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',dateStyle:'short'}).format(instant);
const absent=reason=>({status:'waiting_input',reason,items:[],pending:[]});

export async function replayReportZhihu(home,plan,{readBodies=readNativeZhihuReportBodies,preparePreview=prepareIsolatedReportPreview}={}) {
  const checkpoint=plan.zhihuCheckpoint;
  if(!checkpoint?.sources.length)return absent('zhihu_report_checkpoint_missing');
  const captures=path.join(path.dirname(home),'SubscriptionDiscoveryCapture');
  const request=await readJson(path.join(captures,'zhihu',plan.cycle,'input.json'));
  if(!request)return absent('zhihu_report_capture_missing');
  const registry=await readJson(path.join(captures,'registry.json'));
  if(!registry?.enabled || !Array.isArray(registry.zhihu) || !Array.isArray(request.sources) ||
    registry.revision!==plan.revision || request.revision!==plan.revision ||
    request.cycle!==plan.cycle || hash(registry.zhihu)!==hash(request.sources) ||
    !checkpoint.sources.every(source=>request.sources?.includes(source.url)))return absent('zhihu_report_capture_wrong_scope_or_revision');
  let sealed, columns;
  try{
    sealed=await readSealedDiscovery(captures,'zhihu',plan.cycle,request);
    if(!sealed)return absent('zhihu_report_capture_missing');
    if(localDate(new Date(sealed.finishedAt))!==plan.cycle.slice(10))return absent('zhihu_report_capture_wrong_cycle');
    columns=verifyZhihuDiscovery(request,sealed.result);
  }catch{return absent('zhihu_report_capture_integrity_failed');}

  const work=path.join(home,'zhihu-replay',plan.cycle,hash([sealed.sha256,checkpoint,plan.rssCheckpoint.knownKeys]));
  return withLock(path.join(work,'replay.lock'),async()=>{
    const savedFile=path.join(work,'result.json');
    const saved=await readJson(savedFile);
    let confirmed=[];
    if(saved){
      if(saved.resultSha256!==hash(saved.replay))return absent('zhihu_report_replay_integrity_failed');
      for(const item of saved.replay.items){
        const request=await fs.readFile(item.requestFile).catch(()=>null);
        const preview=await fs.readFile(item.previewFile).catch(()=>null);
        if(!request || digest(request)!==item.requestSha256 || digest(JSON.parse(request).material?.markdown || '')!==item.bodySha256 ||
          !preview || digest(preview)!==item.previewSha256)return absent('zhihu_report_replayed_artifact_changed');
      }
      if(!saved.replay.pending.some(row=>row.reason==='isolated_preview_unavailable'))return saved.replay;
      confirmed=saved.replay.items;
    }
    const items=[...confirmed],pending=[];
    const seen=new Set([...plan.rssCheckpoint.knownKeys,...confirmed.map(item=>item.key)]);
    const groups=checkpoint.sources.flatMap(source=>{
      const prior=new Set(source.seen);
      const selected=columns.get(source.url).materials.filter(item=>{
        const key=digest(materialKey(item.url)), backfill=['all','since'].includes(source.history_mode);
        return includesPublication(source,item.published_at) && !seen.has(key) &&
          (backfill || (source.baseline_ready && !prior.has(key)));
      });
      return selected.length ? [{url:source.url,source,items:selected}] : [];
    });
    const bodies=groups.length ? await readBodies(groups.map(({url,items})=>({url,items}))).catch(()=>null) : new Map();
    const failures=new Map();
    for(const {source,url,items:selected} of groups){
      for(const item of selected){
        const key=digest(materialKey(item.url));
        if(seen.has(key))continue;
        const body=bodies?.get(url)?.get(item.key);
        try{
          if(!body?.html)throw Error(body?.reason || 'zhihu_report_native_session_unavailable');
          if(!item.revision || item.url!==body.url || item.revision!==body.revision)throw Error('zhihu_report_article_revision_changed');
          if(body.method!=='zhihu_column_embedded_body' || /<\s*(?:script|iframe|form|object|embed)\b|\b(?:access_token|sessionid|xsrf|authorization)=/iu.test(body.html))
            throw Error('zhihu_report_article_body_unverified');
          const markdown=htmlArticleToMarkdown({html:body.html,sourceUrl:item.url,title:item.title}).markdown;
          const length=meaningfulLength(markdown);
          if(!length)throw Error('zhihu_report_article_body_incomplete');
          if(length<LONG_THRESHOLD)throw Error('short_report_delivery_owned_by_windows');
          const record=await saveSourceMaterial(work,source,item,markdown);
          const requestFile=record.preprocess_request, request=await fs.readFile(requestFile);
          const bodySha256=digest(markdown), requestSha256=digest(request);
          if(record.content_hash!==bodySha256 || JSON.parse(request).material?.markdown!==markdown)throw Error('zhihu_report_body_hash_mismatch');
          const entry={material_id:record.material_id,item_url:item.url,platform:'zhihu',eligible_for_preprocess:true,route:'long_review',
            meaningful_length:length,preprocess_request_path:requestFile,preprocess_request_sha256:requestSha256,
            reading_options:{direct_reading:source.direct_reading,generate_guide:source.generate_guide,translation_mode:source.translation_mode}};
          const preview=await preparePreview(work,entry);
          const previewFile=entry.review_preview.result_path;
          if(digest(await fs.readFile(requestFile))!==requestSha256 || digest(await fs.readFile(previewFile))!==preview.previewSha256)
            throw Error('zhihu_report_preview_integrity_failed');
          seen.add(key);
          failures.delete(key);
          items.push({sourceId:source.id,url:item.url,sourceRevision:item.revision,key,id:entry.material_id,input:preview.input,
            placement:'same_cycle_daily',bodyMethod:body.method,bodySha256,requestFile,requestSha256,
            previewFile,previewSha256:preview.previewSha256,consumerSha256:preview.consumerSha256});
        }catch(error){
          failures.set(key,{sourceId:source.id,key,reason:/^(?:zhihu_report_[a-z_]+|short_report_delivery_owned_by_windows)$/u.test(error.message) ?
            error.message : 'isolated_preview_unavailable'});
        }
      }
    }
    pending.push(...failures.values());
    const replay={status:items.length?'provisional_draft':'waiting_input',captureSha256:sealed.sha256,items,pending};
    await writeJson(savedFile,{replay,resultSha256:hash(replay)});
    return replay;
  },{waitMs:5000});
}
