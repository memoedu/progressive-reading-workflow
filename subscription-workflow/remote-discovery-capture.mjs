import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { SCHEDULE, digest, readJson, withLock, writeJson } from './config.mjs';
import { zhihuColumnIdentity } from '../scripts/import-rule-catalog.mjs';
import { videoId } from '../video-workflow/watch-core.mjs';

const host = 'mac-mini-tailscale';
const schema = 'progressive-reading.scheduled-discovery/v1';
const registrySchema = 'progressive-reading.discovery-registry/v1';
const dates = /^scheduled-\d{4}-\d{2}-\d{2}$/u;
const bvid = /^BV[0-9A-Za-z]{10}$/u;
const hashes = /^[a-f0-9]{64}$/u;
const maxBytes = 4*1024*1024;
const kinds = new Set(['zhihu','bilibili']);
const bindingFiles = {zhihu:'remote-zhihu-discovery.json',bilibili:'remote-video-discovery.json'};
const wireSchemas = {zhihu:'progressive-reading.zhihu-discovery/v1',bilibili:'progressive-reading.video-discovery/v1'};
const hash = value=>digest(JSON.stringify(value));
const fail = reason=>{throw Error('scheduled_discovery_'+reason);};
const hasOnly = (value,keys)=>value && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const columnUrl = url=>{
  try{
    const u=new URL(url);
    return typeof url==='string' && !u.username && !u.password && !u.port && !u.search && !u.hash &&
      u.protocol==='https:' && Boolean(zhihuColumnIdentity(url));
  }catch{return false;}
};

export function discoveryRegistry(config) {
  const sources=config.subscriptions.filter(source=>source.enabled);
  return validateRegistry({schema:registrySchema,enabled:config.enabled,revision:config.revision,
    zhihu:sources.filter(source=>source.kind==='zhihu_column').map(source=>source.url),
    bilibili:sources.filter(source=>['bilibili_collection','bilibili_video'].includes(source.kind)).map(source=>
      ({bvid:videoId(source.url),collection:source.kind==='bilibili_collection'}))});
}

function validateRegistry(registry) {
  if (!hasOnly(registry,['schema','enabled','revision','zhihu','bilibili']) || registry.schema!==registrySchema ||
      typeof registry.enabled!=='boolean' || !Number.isSafeInteger(registry.revision) || registry.revision<1 ||
      !Array.isArray(registry.zhihu) || registry.zhihu.length>30 || !registry.zhihu.every(columnUrl) ||
      new Set(registry.zhihu).size!==registry.zhihu.length || !Array.isArray(registry.bilibili) || registry.bilibili.length>30 ||
      !registry.bilibili.every(watch=>hasOnly(watch,['bvid','collection']) && bvid.test(watch.bvid) && typeof watch.collection==='boolean'))
    fail('registry_invalid');
  return registry;
}

export async function publishDiscoveryRegistry(home,input) {
  const proposed=validateRegistry(input), file=path.join(home,'registry.json');
  return withLock(file+'.lock',async()=>{
    const old=await readJson(file);
    if (old && proposed.revision<old.revision) fail('stale_revision');
    if (old && proposed.revision===old.revision && hash(old)!==hash(proposed)) fail('same_revision_conflict');
    if (!old || proposed.revision>old.revision) await writeJson(file,proposed);
    return registryStatus(await readJson(file));
  },{waitMs:2000});
}

function registryStatus(registry) {
  validateRegistry(registry);
  return {revision:registry.revision,enabled:registry.enabled,zhihu:registry.zhihu.length,bilibili:registry.bilibili.length,sha256:hash(registry)};
}

export function latestDiscoveryCycle(kind,now=new Date()) {
  if (!kinds.has(kind)) fail('kind_invalid');
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:SCHEDULE.timezone,
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const fields=Object.fromEntries(formatter.formatToParts(now).map(({type,value})=>[type,value]));
  const date=fields.year+'-'+fields.month+'-'+fields.day;
  if ((fields.hour+':'+fields.minute)>=SCHEDULE[kind]) return 'scheduled-'+date;
  return 'scheduled-'+new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
}

function cycleFiles(home,kind,cycle) {
  if (!kinds.has(kind) || !dates.test(cycle || '')) fail('identity_invalid');
  const root=path.join(home,kind,cycle);
  return {input:path.join(root,'input.json'),capture:path.join(root,'capture.json'),receipt:path.join(root,'receipt.json'),
    consumed:path.join(root,'consumed.json'),lock:path.join(root,'capture.lock')};
}

function validateCapture(kind,cycle,envelope) {
  const {sha256,...body}=envelope || {};
  if(body.schema!==schema || body.kind!==kind || body.cycle!==cycle || !hashes.test(body.requestSha256 || '') ||
    body.result?.schema!==wireSchemas[kind] || body.result.requestSha256!==body.requestSha256 ||
    !hashes.test(body.result.resultSha256 || '') || !Number.isFinite(Date.parse(body.finishedAt)) || sha256!==hash(body))
    fail('capture_invalid');
  return envelope;
}

async function generate(kind,request,options) {
  if(kind==='zhihu') return (await import('./zhihu-discovery-stage.mjs')).generateNativeZhihuDiscovery(request,options);
  return (await import('./video-discovery-stage.mjs')).generateVideoDiscovery(request);
}

export async function captureDiscovery(home,kind,cycle,registry,{ produce=generate }={}) {
  validateRegistry(registry);
  const files=cycleFiles(home,kind,cycle);
  if (!registry.enabled || !registry[kind].length) return {status:'inactive',kind,cycle,revision:registry.revision};
  const planned={schema:wireSchemas[kind],cycle,revision:registry.revision,
    ...(kind==='zhihu' ? {sources:registry.zhihu} : {watches:registry.bilibili.map(watch=>({...watch,season_id:null}))})};
  return withLock(files.lock,async()=>{
    const saved=await readJson(files.input);
    if (saved && hash(saved)!==hash(planned)) fail('cycle_input_conflict');
    if (!saved) await writeJson(files.input,planned);
    let sealed=await readJson(files.capture);
    if (!sealed) {
      const reportBodies=kind==='zhihu' && await (await import('./report-zhihu-body-capture.mjs')).collectZhihuReportBodies(home,planned).catch(()=>null);
      const result=await produce(kind,planned,reportBodies && {onMaterial:reportBodies.observe} || undefined);
      const payload={schema,kind,cycle,requestSha256:hash(planned),result,finishedAt:new Date().toISOString()};
      sealed=validateCapture(kind,cycle,{...payload,sha256:hash(payload)});
      if (Buffer.byteLength(JSON.stringify(sealed))>maxBytes-65536) fail('capture_size_limit');
      if(reportBodies)await reportBodies.seal(sealed).catch(()=>null);
      await writeJson(files.capture,sealed);
    }
    validateCapture(kind,cycle,sealed);
    if (sealed.requestSha256!==hash(planned)) fail('capture_input_conflict');
    const receipt={status:'completed',kind,cycle,revision:registry.revision,sources:registry[kind].length,
      finishedAt:sealed.finishedAt,sha256:sealed.sha256,resultSha256:sealed.result.resultSha256};
    const previous=await readJson(files.receipt);
    if (previous && hash(previous)!==hash(receipt)) fail('receipt_conflict');
    if (!previous) await writeJson(files.receipt,receipt);
    return receipt;
  },{waitMs:5000});
}

export async function readSealedDiscovery(home,kind,cycle,request) {
  const files=cycleFiles(home,kind,cycle), receipt=await readJson(files.receipt);
  if (!receipt) return null;
  const sealed=validateCapture(kind,cycle,await readJson(files.capture));
  if (receipt.sha256!==sealed.sha256 || receipt.resultSha256!==sealed.result.resultSha256 ||
      receipt.status!=='completed' || receipt.kind!==kind || receipt.cycle!==cycle ||
      receipt.revision!==request.revision || receipt.finishedAt!==sealed.finishedAt ||
      receipt.sources!==(request.sources || request.watches)?.length || sealed.requestSha256!==hash(request)) fail('capture_mismatch');
  return sealed;
}

export async function acknowledgeDiscovery(home,kind,cycle,{sha256,jobId}) {
  const files=cycleFiles(home,kind,cycle);
  if (!hashes.test(sha256 || '') || jobId!==digest(kind+':'+cycle).slice(0,32)) fail('ack_identity_invalid');
  return withLock(files.lock,async()=>{
    const receipt=await readJson(files.receipt);
    if (receipt?.sha256!==sha256) fail('ack_mismatch');
    const old=await readJson(files.consumed);
    if (old) {
      if (old.sha256!==sha256 || old.jobId!==jobId) fail('ack_conflict');
      return old;
    }
    const record={kind,cycle,sha256,jobId,consumedAt:new Date().toISOString()};
    await writeJson(files.consumed,record);
    return record;
  },{waitMs:5000});
}

export async function pendingDiscoveryCycles(home,kind,through) {
  cycleFiles(home,kind,through);
  const root=path.join(home,kind);
  const folders=await fs.readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT') return [];throw error;});
  const result=[];
  for (const folder of folders) {
    const cycle=folder.name;
    if (!folder.isDirectory() || !dates.test(cycle) || cycle>through) continue;
    try {
      const files=cycleFiles(home,kind,cycle);
      if (await readJson(files.consumed)) continue;
      const request=await readJson(files.input);
      const sealed=request && await readSealedDiscovery(home,kind,cycle,request);
      if(sealed) result.push({cycle,revision:request.revision,sha256:sealed.sha256});
    } catch {
      // A damaged cycle cannot schedule a catch-up business job.
    }
  }
  return result.sort((left,right)=>left.cycle.localeCompare(right.cycle));
}

function transfer(binding,operation,kind='zhihu',cycle='-',input) {
  if (binding.host!==host || !/^\/Users\/[A-Za-z0-9_-]+$/u.test(binding.home || '') || !kinds.has(kind) ||
      (cycle!=='-' && !dates.test(cycle))) fail('transport_invalid');
  const remote=binding.home+'/Agent/Projects/progressive-reading-workflow/subscription-workflow/remote-discovery-capture.mjs';
  const base=binding.home+'/Agent/AppData/ProgressiveReading/SubscriptionDiscoveryCapture';
  const command='exec '+binding.home+'/.local/bin/node '+remote+' '+operation+' '+base+' '+kind+' '+cycle;
  return new Promise((resolve,reject)=>{
    const child=execFile('ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no',
      '-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','ConnectTimeout=4',host,command],
      {windowsHide:true,timeout:operation==='receive'?45000:6500,maxBuffer:maxBytes},(error,stdout,stderr)=>{
        if (error) {
          const line=stderr?.trim();
          return reject(Error(/^scheduled_discovery_[a-z_]+$/u.test(line || '')?line:'scheduled_discovery_unavailable'));
        }
        try{resolve(JSON.parse(stdout));}catch{reject(Error('scheduled_discovery_invalid_response'));}
      });
    child.stdin.on('error',()=>{});
    child.stdin.end(input===undefined ? undefined : JSON.stringify(input));
  });
}

export async function readDiscoveryBinding(home,kind) {
  if(!kinds.has(kind))fail('kind_invalid');
  return readJson(path.join(home,bindingFiles[kind]));
}

export async function synchronizeDiscoveryRegistry(home,{send=transfer,binding}={}) {
  if (!binding) {
    const settings=await Promise.all([...kinds].map(kind=>readDiscoveryBinding(home,kind)));
    binding=settings.find(setting=>setting?.enabled===true && setting.scheduledCapture===true);
    if (!binding) return null;
  }
  const projection=discoveryRegistry(await readJson(path.join(home,'subscriptions.json')));
  const result=await send(binding,'publish','zhihu','-',projection);
  if (!result || hash(result)!==hash(registryStatus(projection))) fail('registry_readback_mismatch');
  return result;
}

export async function receiveDiscovery(binding,kind,request,{send=transfer}={}) {
  const sealed=await send(binding,'receive',kind,request.cycle,request);
  if (!sealed) fail('capture_missing');
  validateCapture(kind,request.cycle,sealed);
  if (sealed.requestSha256!==hash(request)) fail('capture_mismatch');
  return sealed;
}

export async function listDiscoveryCycles(binding,kind,through,{send=transfer}={}) {
  const candidates=await send(binding,'pending',kind,through);
  if (!Array.isArray(candidates) || candidates.some(item=>!dates.test(item?.cycle || '') ||
      item.cycle>through || !Number.isSafeInteger(item.revision) || item.revision<1 ||
      !hashes.test(item.sha256 || ''))) fail('pending_invalid');
  return candidates;
}

export async function acknowledgeRemoteDiscovery(binding,kind,cycle,receipt,{send=transfer}={}) {
  return send(binding,'ack',kind,cycle,receipt);
}

async function stdin() {
  let input='';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input+=chunk;
    if (input.length>256*1024) fail('input_too_large');
  }
  return JSON.parse(input.replace(/^\uFEFF/u,''));
}

async function main() {
  process.umask(0o077);
  const [op,home,kind,cycle]=process.argv.slice(2);
  if (!path.isAbsolute(home || '') || !kinds.has(kind)) fail('arguments_invalid');
  if (op==='registry') return registryStatus(await readJson(path.join(home,'registry.json')));
  if (op==='publish') return publishDiscoveryRegistry(home,await stdin());
  if (op==='run') return captureDiscovery(home,kind,cycle || latestDiscoveryCycle(kind),await readJson(path.join(home,'registry.json')));
  if (op==='pending') return pendingDiscoveryCycles(home,kind,cycle);
  if (op==='ack') return acknowledgeDiscovery(home,kind,cycle,await stdin());
  if (op==='status' || op==='consumed') return readJson(cycleFiles(home,kind,cycle)[op==='status'?'receipt':'consumed']);
  if (op==='receive') {
    const request=await stdin();
    const wait=latestDiscoveryCycle(kind)===cycle && Date.now()-Date.parse(cycle.slice(10)+'T'+SCHEDULE[kind]+':00+08:00')<120000;
    for (let attempt=0;attempt<=(wait?30:0);attempt++) {
      const sealed=await readSealedDiscovery(home,kind,cycle,request);
      if (sealed) return sealed;
      if (wait && attempt<30) await pause(1000);
    }
    return null;
  }
  fail('operation_invalid');
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result=>console.log(JSON.stringify(result))).catch(error=>{
    console.error(/^scheduled_discovery_[a-z_]+$/u.test(error?.message || '')?error.message:'scheduled_discovery_capture_failed');
    process.exitCode=1;
  });
}
