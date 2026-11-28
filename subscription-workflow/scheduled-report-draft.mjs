import fs from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {SCHEDULE,digest,loadConfig,paths,readJson,withLock,writeJson} from './config.mjs';

export const reportPlanSchema='progressive-reading.scheduled-report-draft/v1';
const reportKinds=['daily','weekly'], sourceKinds=['rss','zhihu','bilibili'];
const dayMs=86400000, zone='Asia/Shanghai', limit=4*1024*1024;
const datePattern=/^scheduled-\d{4}-\d{2}-\d{2}$/u;
const shaPattern=/^[a-f0-9]{64}$/u;
const hash=value=>digest(JSON.stringify(value));
const fail=reason=>{throw Error('scheduled_report_'+reason);};
const jobId=(kind,cycle)=>digest(kind+':'+cycle).slice(0,32);
const dateForClock=instant=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,dateStyle:'short'}).format(instant);
const iso=instant=>new Date(instant).toISOString().slice(0,10);

function dueAt(kind,cycle) {
  if(!reportKinds.includes(kind) || !datePattern.test(cycle))fail('cycle_invalid');
  const date=cycle.slice(10), weekday=new Date(date+'T00:00:00Z').getUTCDay();
  const due=Date.parse(date+'T'+SCHEDULE[kind]+':00+08:00');
  if(!Number.isFinite(due) || dateForClock(new Date(due))!==date || (kind==='weekly' && weekday!==SCHEDULE.weekly_day))fail('cycle_invalid');
  return due;
}

export function reportCycle(kind,now=new Date(),{next=false}={}) {
  if(!reportKinds.includes(kind))fail('kind_invalid');
  let date=dateForClock(now);
  const interval=kind==='weekly'?7:1;
  if(kind==='weekly')date=iso(Date.parse(date+'T00:00:00Z')-new Date(date+'T00:00:00Z').getUTCDay()*dayMs);
  const due=dueAt(kind,'scheduled-'+date);
  if(next ? now>=due : now<due)date=iso(Date.parse(date+'T00:00:00Z')+(next?1:-1)*interval*dayMs);
  return 'scheduled-'+date;
}

function cycleFiles(home,kind,cycle) {
  dueAt(kind,cycle);
  const dir=path.join(home,kind,cycle);
  return Object.fromEntries(['input','draft','receipt','consumed'].map(name=>[name,path.join(dir,name+'.json')]).concat([['lock',path.join(dir,'cycle.lock')]]));
}

function exact(object,keys) {
  return object && typeof object==='object' && !Array.isArray(object) && Object.keys(object).every(key=>keys.includes(key));
}

function validatePlan(plan,kind,cycle) {
  if(!exact(plan,['schema','kind','cycle','revision','frozenAt','ledgerSha256','coverage','missingPreviews','input','rssCheckpoint']) ||
     plan.schema!==reportPlanSchema || plan.kind!==kind || plan.cycle!==cycle ||
     !Number.isSafeInteger(plan.revision) || plan.revision<1 || !Number.isFinite(Date.parse(plan.frozenAt)) ||
     !shaPattern.test(plan.ledgerSha256||'') || !Number.isSafeInteger(plan.missingPreviews) || plan.missingPreviews<0 ||
     !Array.isArray(plan.coverage) || new Set(plan.coverage.map(row=>row.kind)).size!==plan.coverage.length ||
     !plan.coverage.every(row=>exact(row,['kind','jobId','sha256']) && sourceKinds.includes(row.kind) &&
       (row.jobId===null ? row.sha256===null : row.jobId===jobId(row.kind,cycle) && shaPattern.test(row.sha256||''))) ||
     !Array.isArray(plan.input) || plan.input.length>3000 || new Set(plan.input.map(row=>row.id)).size!==plan.input.length)fail('plan_invalid');
  for(const row of plan.input) {
    const p=row?.preview;
    if(!exact(row,['id','direct','length','preview']) || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(row.id || '') ||
        typeof row.direct!=='boolean' || !Number.isSafeInteger(row.length) || row.length<0 ||
        !exact(p,['status','core','value_level','value_reason','novelty','continue_reading']) || p.status!=='ready' ||
        !['core','value_level','value_reason','novelty'].every(key=>p[key]==null || typeof p[key]==='string') ||
        !exact(p.continue_reading,['level']) ||
        !(p.continue_reading.level==null || ['string','number'].includes(typeof p.continue_reading.level)))fail('preview_invalid');
  }
  const checkpoint=plan.rssCheckpoint;
  if(checkpoint!==undefined && (!exact(checkpoint,['knownKeys','sources']) ||
    !Array.isArray(checkpoint.knownKeys) || !checkpoint.knownKeys.every(key=>shaPattern.test(key)) ||
    !Array.isArray(checkpoint.sources) || !checkpoint.sources.every(s=>
      exact(s,['id','url','kind','enabled','mode','history_mode','earliest_date','direct_reading','generate_guide','translation_mode']) &&
        s.kind==='rss' && s.enabled===true && /^https?:\/\//u.test(s.url || ''))))fail('rss_checkpoint_invalid');
  if(Buffer.byteLength(JSON.stringify(plan))>limit)fail('plan_too_large');
}

export async function putReportPlan(home,kind,cycle,plan) {
  validatePlan(plan,kind,cycle);
  const f=cycleFiles(home,kind,cycle), planSha256=hash(plan);
  return withLock(f.lock,async()=>{
    const previous=await readJson(f.input);
    if(previous && hash(previous)===planSha256)return {status:'already_current',planSha256};
    const consumed=await readJson(f.consumed);
    if(consumed && plan.revision<=(consumed.revision ?? previous?.revision ?? 0))fail('already_consumed');
    if(previous && (plan.revision<previous.revision ||
      (plan.revision===previous.revision && Date.parse(plan.frozenAt)<=Date.parse(previous.frozenAt))))fail('stale_plan');
    await writeJson(f.input,plan);
    return {status:'stored',planSha256};
  },{waitMs:5000});
}

async function sourceEvidence(home,cycle) {
  const base=path.dirname(home), discovery=path.join(base,'SubscriptionDiscoveryCapture'), rss=path.join(base,'SubscriptionFeedCapture');
  const found=await Promise.all([readJson(path.join(rss,'registry.json')),readJson(path.join(discovery,'registry.json'))]);
  const revision=Math.max(0,...found.map(row=>row?.revision||0));
  const seals=await Promise.all([readJson(path.join(rss,cycle,'receipt.json')),
    ...sourceKinds.slice(1).map(kind=>readJson(path.join(discovery,kind,cycle,'receipt.json')))]);
  return {revision,macSources:seals.flatMap((receipt,index)=>receipt?.status==='completed' && receipt.revision===revision
    ? [{kind:sourceKinds[index],sha256:receipt.sha256 ?? receipt.captureSha256 ?? null}] : [])};
}

export async function sealReportDraft(home,kind,cycle,{now,render}={}) {
  const started=now ?? new Date();
  if(started<dueAt(kind,cycle))fail('not_due');
  const f=cycleFiles(home,kind,cycle);
  return withLock(f.lock,async()=>{
    const plan=await readJson(f.input), evidence=await sourceEvidence(home,cycle);
    const planSha256=plan ? hash(plan) : null;
    const consumed=await readJson(f.consumed);
    const prior=await readJson(f.receipt);
    if(consumed?.planSha256===planSha256 && plan?.revision>=evidence.revision)return prior;
    if(plan)validatePlan(plan,kind,cycle);
    const matchesRevision=plan && plan.revision>=evidence.revision;
    const earlier=matchesRevision ? [...plan.input] : [];
    const issue=!plan?'missing_plan':!matchesRevision?'stale_revision':plan.coverage.some(row=>!row.jobId)?'source_checkpoint_missing':
      plan.missingPreviews?'previews_missing':null;
    let rssReplay=null;
    if(matchesRevision && issue && plan.rssCheckpoint && plan.coverage.some(row=>row.kind==='rss' && !row.jobId)){
      const {replayReportRss}=await import('./report-rss-replay.mjs');
      const replay=await replayReportRss(home,plan).catch(()=>({status:'waiting_input',reason:'rss_replay_unavailable',items:[],pending:[]}));
      const {items,...details}=replay;
      rssReplay={...details,items:items.map(({input,bodyFile,previewFile,...evidence})=>evidence)};
      earlier.push(...items.filter(item=>!earlier.some(row=>row.id===item.id)).map(item=>item.input));
    }
    const input=earlier;
    const status=!issue?'draft_ready':rssReplay?.items.length?'provisional_draft':'waiting_input';
    if(prior && prior.planSha256===planSha256 && prior.reason===issue && hash(prior.macSources)===hash(evidence.macSources) &&
       prior.revision===Math.max(plan?.revision||0,evidence.revision) && prior.status===status &&
       prior.inputSha256===hash(input) && hash(prior.rssReplay ?? null)===hash(rssReplay)) {
      const draft=await readJson(f.draft);
      if(hash(draft)!==prior.resultSha256)fail('draft_changed');
      return prior;
    }
    render ||= (await import('../rss-reading/core.mjs')).renderGeneratedReportDraft;
    const draft=render(input);
    const receipt={schema:reportPlanSchema,status,reason:issue,kind,cycle,
      revision:Math.max(plan?.revision||0,evidence.revision),jobId:jobId(kind,cycle),
      planSha256,inputSha256:hash(input),resultSha256:hash(draft),items:input.length,macSources:evidence.macSources,
      missingSources:plan?.coverage.filter(row=>!row.jobId).map(row=>row.kind) ?? null,missingPreviews:plan?.missingPreviews ?? null,
      ...(rssReplay ? {rssReplay} : {}),
      startedAt:started.toISOString(),finishedAt:(now ?? new Date()).toISOString(),publishable:false};
    await writeJson(f.draft,draft);
    await writeJson(f.receipt,receipt);
    return receipt;
  },{waitMs:5000});
}

export async function receiveSealedReportDraft(home,kind,cycle,{revision,inputSha256}) {
  const f=cycleFiles(home,kind,cycle);
  return withLock(f.lock,async()=>{
    const saved=await readJson(f.receipt), plan=await readJson(f.input);
    if(!saved || saved.status!=='draft_ready' || saved.revision!==revision || saved.inputSha256!==inputSha256 ||
       saved.planSha256!==hash(plan) || revision<(await sourceEvidence(home,cycle)).revision)return null;
    const draft=await readJson(f.draft);
    if(hash(draft)!==saved.resultSha256)fail('draft_changed');
    return {receipt:saved,draft};
  },{waitMs:5000});
}

export async function confirmSealedReportDraft(home,kind,cycle,confirmation) {
  const f=cycleFiles(home,kind,cycle);
  return withLock(f.lock,async()=>{
    const saved=await readJson(f.receipt), plan=await readJson(f.input);
    if(saved?.status!=='draft_ready' || saved.planSha256!==confirmation.planSha256 ||
       saved.resultSha256!==confirmation.resultSha256 || confirmation.jobId!==jobId(kind,cycle))fail('confirmation_mismatch');
    if(!plan || plan.revision!==saved.revision || hash(plan)!==saved.planSha256 ||
      saved.revision<(await sourceEvidence(home,cycle)).revision || hash(await readJson(f.draft))!==saved.resultSha256)fail('confirmation_stale');
    const prior=await readJson(f.consumed);
    if(prior?.planSha256===saved.planSha256)return prior;
    const record={kind,cycle,jobId:saved.jobId,revision:saved.revision,planSha256:saved.planSha256,
      resultSha256:saved.resultSha256,consumedAt:new Date().toISOString()};
    await writeJson(f.consumed,record);
    return record;
  },{waitMs:5000});
}

export async function collectReportPlans(root,now=new Date()) {
  const p=paths(root), cfg=await loadConfig(root);
  if(!cfg?.enabled)return [];
  const sourceKind=source=>source.kind.startsWith('zhihu_')?'zhihu':source.kind.startsWith('bilibili_')?'bilibili':'rss';
  const needed=sourceKinds.filter(kind=>cfg.subscriptions.some(s=>s.enabled && sourceKind(s)===kind));
  const periods=reportKinds.map(kind=>({kind,date:reportCycle(kind,now,{next:true}).slice(10)}));
  const {prepareScheduledReportDrafts}=await import('../rss-reading/core.mjs');
  const {plans,knownUrls}=await prepareScheduledReportDrafts(root,periods);
  const {materialKey}=await import('./catalog.mjs');
  const knownKeys=[...new Set(knownUrls.map(url=>digest(materialKey(url))))].sort();
  const sources=cfg.subscriptions.filter(s=>s.enabled && s.kind==='rss').map(
    ({id,url,kind,enabled,mode,history_mode,earliest_date,direct_reading,generate_guide,translation_mode})=>
      ({id,url,kind,enabled,mode,history_mode,earliest_date,direct_reading,generate_guide,translation_mode}));
  const rssCheckpoint={knownKeys,sources};
  const frozenAt=new Date().toISOString();
  if((await readJson(p.config))?.revision!==cfg.revision)fail('config_changed');
  const scopes=await readJson(path.join(p.home,'applied-source-scopes.json'),{});
  return Promise.all(plans.map(async({kind,date,input,missingPreviews,ledgerSha256})=>{
    const cycle='scheduled-'+date;
    const coverage=await Promise.all(needed.map(async source=>{
      const id=jobId(source,cycle), file=path.join(p.jobs,id+'.json');
      const raw=await fs.readFile(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      const j=raw && JSON.parse(raw);
      const scopePending=cfg.subscriptions.some(s=>s.enabled && sourceKind(s)===source && ['since','all'].includes(s.history_mode) &&
        scopes[s.id]!==JSON.stringify([s.history_mode,s.earliest_date,s.mode,s.updated_at]));
      const ready=!scopePending && j?.reportSourceRevision===cfg.revision && ['completed','completed_with_issues'].includes(j.status) &&
        ['scan','previews','decisions'].every(step=>j.steps?.[step]?.done) && !j.steps.scan.result?.errors?.length &&
        !j.steps.previews.result?.failures?.length && !j.steps.scan.result?.events?.some(event=>event.status==='waiting_source') &&
        !j.steps.scan.result?.reports?.results?.some(result=>!result.ok) && !j.steps.scan.result?.auto?.feeds?.some(feed=>feed.error);
      return {kind:source,jobId:ready?id:null,sha256:ready?digest(raw):null};
    }));
    return {schema:reportPlanSchema,kind,cycle,revision:cfg.revision,frozenAt,ledgerSha256,coverage,missingPreviews,input,rssCheckpoint};
  }));
}

async function stdin() {
  let text='';
  for await(const chunk of process.stdin.setEncoding('utf8')) {
    text+=chunk;
    if(Buffer.byteLength(text)>limit)fail('request_too_large');
  }
  return JSON.parse(text.replace(/^\uFEFF/u,''));
}

async function main() {
  process.umask(0o077);
  const [op,home,kind,explicit]=process.argv.slice(2);
  if(!path.isAbsolute(home||''))fail('path_invalid');
  const cycle=explicit||reportCycle(kind);
  if(op==='run') {
    if(process.platform==='darwin'){
      const cache=path.join(homedir(),'Agent','Caches','ProgressiveReading');
      process.env.AI_PRODUCER_CODEX_BIN ||= path.join(homedir(),'.local','bin','codex');
      process.env.AI_PRODUCER_CODEX_WORK_DIR ||= path.join(cache,'codex-exec');
      process.env.PR_PREPROCESS_CACHE_DIR ||= path.join(cache,'preprocess');
      process.env.PR_TRANSLATION_PROMPT_PATH ||= path.join(homedir(),'Agent','AppData','ProgressiveReading','TranslationPrompts','general-translation.txt');
    }
    return sealReportDraft(home,kind,cycle);
  }
  if(op==='publish')return putReportPlan(home,kind,cycle,await stdin());
  if(op==='receive') {
    const input=await stdin();
    const tries=Date.now()-dueAt(kind,cycle)<90000 ? 10 : 0;
    for(let n=0;n<=tries;n++){
      const result=await receiveSealedReportDraft(home,kind,cycle,input);
      if(result)return result;
      if(n<tries)await pause(700);
    }
    return null;
  }
  if(op==='ack')return confirmSealedReportDraft(home,kind,cycle,await stdin());
  if(op==='status' || op==='consumed')return readJson(cycleFiles(home,kind,cycle)[op==='status'?'receipt':'consumed']);
  fail('operation_invalid');
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(value=>console.log(JSON.stringify(value))).catch(error=>{
    console.error(/^scheduled_report_[a-z_]+$/u.test(error.message)?error.message:'scheduled_report_failed');
    process.exitCode=1;
  });
}
