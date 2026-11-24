import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson, withLock, digest } from '../subscription-workflow/config.mjs';
import { findSourcePublications, sourceReuseResult } from '../scripts/reading-source-library.mjs';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';
import { processCollectionTask } from '../scripts/collection-import.mjs';
import { discoverSite,inventoryCurrent,retrySiteUrls } from './discovery.mjs';
import { discoverSiteInWorker } from './discovery-worker.mjs';
import { readSources, readRun, saveRun, listRuns, runPath, runId, siteCounts, now } from './store.mjs';
import {organizeSiteFiles} from './organization.mjs';
import {writeSiteIndexes} from './indexes.mjs';
import {bindRepositoryRelations} from '../scripts/source-relations.mjs';
import {writeRepositoryIndexes} from './repository-indexes.mjs';
import {ensureSiteRss} from './rss.mjs';
import {capturedArticle} from './article-capture.mjs';
import {recoverTruncatedOriginal} from './original-publication-recovery.mjs';

export {capturedArticle} from './article-capture.mjs';

export const siteProcessingOptions=settings=>({input_form:'written',content_profile:'natural_language',spoken_to_written:false,structure_body:false,
  include_reading_guide:settings.generate_guide===true,translation_mode:settings.translation_mode});

const SUCCESS=new Set(['imported','imported_with_warnings','idempotent_replay']);
const TERMINAL_SITE_PHASES=new Set(['completed','completed_with_failures','failed','needs_classification']);

export async function siteRunStatus(run,broker){
  if(!run?.phase||!run.request_id||TERMINAL_SITE_PHASES.has(run.phase))return run;
  const request=await broker?.getRequest(run.request_id);
  if(!request?.terminal)return run;
  // The broker may finish before the separate site view has been saved.
  const row=request.results?.[0];
  const saved=row?.collection||run.collection;
  const phase=request.awaiting_input?'needs_classification':SUCCESS.has(row?.status)?'completed':
    saved?.phase==='completed_with_failures'?'completed_with_failures':'failed';
  const collection={...saved,phase,...(row?.error&&!saved?.error?{error:row.error}:{})};
  return {...run,phase,collection,results:collection.results||run.results,
    counts:siteCounts(collection),updated_at:request.updated_at||run.updated_at};
}

export async function startSiteRun(root,{source_id,client_request_id,retry_run_id},broker,runRequest,{maintenanceRetryOf=null}={}) {
  if(typeof client_request_id!=='string'||!/^[A-Za-z0-9_.:-]{1,180}$/u.test(client_request_id))throw new Error('导入请求缺少有效的恢复编号');
  if(client_request_id.startsWith('maintenance-retry:')&&!maintenanceRetryOf)throw new Error('reserved_maintenance_request_id');
  const id=runId(client_request_id),directory=runPath(root,id);
  return withLock(directory+'.lock',async()=>{
    let run=await readRun(root,id);
    if(run&&run.source_id!==source_id)throw new Error('恢复编号已经用于另一个整站来源');
    if(run?.request_id){
      run=await siteRunStatus(run,broker);
      if(!TERMINAL_SITE_PHASES.has(run.phase))void runRequest(run.request_id).catch(()=>{});
      return run;
    }
    const config=await readSources(root),source=config.sources.find(s=>s.id===source_id);
    if(!source)throw new Error('请先保存整站导入设置');
    for(const recorded of await listRuns(root)){
      if(recorded.id===id||recorded.source_id!==source_id||TERMINAL_SITE_PHASES.has(recorded.phase))continue;
      const active=await siteRunStatus(recorded,broker);
      if(!TERMINAL_SITE_PHASES.has(active.phase))return active;
    }
    const previous=retry_run_id?await siteRunStatus(await readRun(root,retry_run_id),broker):null;
    if(retry_run_id&&!previous)throw new Error('要重试的整站记录不存在');
    if(previous&&previous.source_id!==source.id)throw new Error('重试任务与来源不一致');
    const settings=run?.settings || previous?.settings || structuredClone(source);
    run ||= {id,source_id:source.id,settings,phase:'queued',created_at:now(),updated_at:now(),client_request_id,
      ...(previous?{retry_of:previous.id}:{}),counts:{discovered:0,imported:0,reused:0,failed:0,warnings:0},results:[]};
    await saveRun(root,run);
    const request=await broker.createRequest([settings.url],{source:'site_import_page',clientRequestId:client_request_id,entryRoute:'ai',destinationFolder:settings.destination,
      userInstruction:settings.instruction,processingMode:settings.processing_mode,processingOptions:siteProcessingOptions(settings),maintenanceRetryOf,
      siteImport:{run_id:id,settings,...(previous?{retry_run_id:previous.id}:{})}});
    run.request_id=request.request_id;await saveRun(root,run);void runRequest(request.request_id).catch(()=>{});return run;
  });
}

export async function verifySiteCollection(root,settings,collection,runId,{broker,onProgress=async()=>{}}={}) {
  const expected=collection.inventory.articles;
  await onProgress('核对已有正文与来源别名');
  // A user may complete/archive or edit an article while discovery is running.
  // Refresh physical locations before planning moves; frozen receipts are not
  // authority to resurrect or overwrite a newer reading state.
  const live=await findSourcePublications(root,expected.map(article=>article.url));
  collection.results=collection.results.map(row=>{const current=live.get(urlImportDedupeKey(row.requested_url)),artifact=row.artifacts?.find(a=>a.kind==='markdown');return current&&(artifact?.path!==current.path||artifact.sha256!==current.sha256)?sourceReuseResult(row.requested_url,current):row;});
  await onProgress('来源核对完成，整理原站目录');
  const organization=expected.some(article=>collection.results.some(row=>row.requested_url===article.url&&SUCCESS.has(row.status)))?await organizeSiteFiles(root,settings,collection,runId,{broker,onProgress}):{};
  await onProgress('回读正式正文与目录链接');
  const rows=new Map(collection.results.map(row=>[row.requested_url,row]));
  const records=[];
  for(const article of expected){
    const row=rows.get(article.url);
    if(!row||!SUCCESS.has(row.status)){records.push({url:article.url,status:'not_imported'});continue;}
    const artifact=row.artifacts?.find(a=>a.kind==='markdown');
    if(!artifact?.path)throw new Error('文章缺少正式 Markdown 回执');
    const bytes=await fs.readFile(artifact.path),hash=digest(bytes);
    if(hash!==artifact.sha256)throw new Error('文章在验收期间发生更改，已保留文件：'+article.url);
    const reused=row.status==='idempotent_replay';
    if(settings.processing_mode==='original_text'&&!reused){
      if(row.receipt?.processing_mode!=='original_text'||row.receipt?.llm_used!==false)throw new Error('原文模式回执未通过');
      const captured=await capturedArticle(root,collection.inventory.article_source,article.url);
      const normalize=value=>String(value).replace(/\r\n/gu,'\n').replace(/\s+/gu,'');
      if(!normalize(bytes.toString('utf8')).includes(normalize(captured.markdown)))throw new Error('原文完整性核验未通过：'+article.url);
    }
    records.push({url:article.url,path:artifact.path,sha256:hash,reused,verified:true});
  }
  let index=null,groups=[];
  if(settings.generate_index&&records.every(row=>row.verified)){const written=await writeSiteIndexes(root,settings,collection.inventory,records,runId,organization);index=written.index;groups=written.groups;}
  const verification={expected:expected.length,verified:records.filter(row=>row.verified).length,records,index,groups,organization:{moved:organization.moved||0,duplicates_retired:organization.duplicates_retired||0,host:organization.host}};
  if(settings.repository&&records.every(row=>row.verified)){
    const captures=await Promise.all(expected.map(article=>capturedArticle(root,collection.inventory.article_source,article.url)));
    verification.source_relations=await bindRepositoryRelations(root,captures,records);
    try {
      verification.repository_indexes=await writeRepositoryIndexes(root,settings,captures,records);
    } catch (error) {
      const prefix='repository_index_user_edit_preserved:';
      if(!error.message.startsWith(prefix))throw error;
      verification.warnings=[{code:'repository_index_user_edit_preserved',
        message:'现有仓库索引有改动，已保留该索引。',path:error.message.slice(prefix.length)}];
    }
  }
  await writeJson(path.join(runPath(root,runId),'verification.json'),verification);return verification;
}

export async function processSiteTask(root,task,{broker,runRequest,planner,fetchPage}={}) {
  const {run_id:id,settings,retry_run_id:retry}=task.site_import;
  const run=await readRun(root,id);if(!run)throw new Error('整站任务记录不存在');
  const previous=retry?await siteRunStatus(await readRun(root,retry),broker):null;
  let retryInventory=null;
  const attempts=new Set();
  const earlierPublications=new Map();
  const retainEarlierPublications=rows=>{
    for(const row of rows || []){
      if(row.status==='imported'&&!earlierPublications.has(row.requested_url))earlierPublications.set(row.requested_url,row);
    }
  };
  for(let earlier=previous;earlier&&earlier.source_id===run.source_id&&!attempts.has(earlier.id);earlier=earlier.retry_of?await siteRunStatus(await readRun(root,earlier.retry_of),broker):null){
    attempts.add(earlier.id);
    if(earlier.collection?.inventory?.plan)retryInventory=earlier.collection.inventory;
    if(settings.processing_mode==='original_text'){
      for(const batch of earlier.collection?.batches || []){
        if(batch.request_id)retainEarlierPublications((await broker.getRequest(batch.request_id))?.results);
      }
      retainEarlierPublications(earlier.collection?.results);
    }
  }
  const previouslyPublished=async(inventory,existing)=>{
    const results=[];
    for(const article of inventory.articles){
      const current=existing.get(urlImportDedupeKey(article.url));
      if(!current)continue;
      const repaired=await recoverTruncatedOriginal(root,article,inventory.article_source,current,earlierPublications.get(article.url));
      results.push(repaired || sourceReuseResult(article.url,current));
    }
    return results;
  };
  const frozenUrls=retrySiteUrls(retryInventory);
  const allowed=new Set(frozenUrls?.map(urlImportDedupeKey));
  const matchesFrozenScope=inventory=>{
    if(!frozenUrls)return true;
    const urls=retrySiteUrls(inventory);
    return urls?.length===allowed.size&&urls.every(url=>allowed.has(urlImportDedupeKey(url)));
  };
  if(task.collection?.inventory?.complete&&!matchesFrozenScope(task.collection.inventory)){
    if(task.collection.batches?.length||task.collection.results?.length)throw Error('现有批次已偏离原任务候选快照，需核对落盘结果');
    task.collection=null;
  }
  const previousInventory=previous?.collection?.inventory;
  const reuseInventory=inventoryCurrent(previousInventory,settings)&&matchesFrozenScope(previousInventory);
  const initial=task.collection || {rule_id:'site-all-articles',phase:'planning',inventory:null,batches:[],results:[]};
  const update=async collection=>{
    run.collection=structuredClone(collection);run.phase=collection.phase;
    run.counts=siteCounts(collection);run.results=collection.results || [];run.updated_at=now();
    await saveRun(root,run);
  };
  await processCollectionTask(task,{broker,runRequest,initialCollection:initial,onProgress:update,
    discover:async(_url,onProgress)=>{
      let savedAt=0,savedStage;
      const reportProgress=async detail=>{
        const at=Date.now();
        if(detail.stage===savedStage&&detail.checked!==detail.total&&at-savedAt<10000)return;
        savedAt=at;savedStage=detail.stage;run.stage=detail.stage;run.discovery=detail;
        await onProgress(detail);
      };
      const discover=planner||fetchPage?discoverSite:discoverSiteInWorker;
      const captureRun=retryInventory?.article_source?.run_id||previous?.id||id;
      const inventory=reuseInventory?structuredClone(previousInventory)
        :await discover(root,settings,captureRun,{planner,fetchPage,onProgress:reportProgress,retryInventory});
      const existing=await findSourcePublications(root,inventory.articles.map(article=>article.url));
      if(reuseInventory){
        const historic=previous.collection.results.filter(row=>SUCCESS.has(row.status)&&!existing.has(urlImportDedupeKey(row.requested_url)));
        inventory.article_source={...inventory.article_source,missing_publications:Object.fromEntries(historic.flatMap(row=>{
          const artifact=row.artifacts?.find(item=>item.kind==='markdown');
          return artifact?.sha256?[[row.requested_url,artifact.sha256]]:[];
        }))};
      }
      initial.results=await previouslyPublished(inventory,existing);
      return inventory;
    },
    verify:async collection=>{
      if(settings.subscribe_rss&&!run.rss?.subscription_id){run.stage='验证并登记 RSS 订阅';await saveRun(root,run);run.rss=await ensureSiteRss(root,settings,{fetchPage});await saveRun(root,run);}
      return verifySiteCollection(root,settings,collection,id,{broker,onProgress:async stage=>{run.stage=stage;run.updated_at=now();await saveRun(root,run);}});
    }});
}
