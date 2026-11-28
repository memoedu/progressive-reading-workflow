import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, readJson } from './config.mjs';
import { biliApi, canonicalUrl, discover, itemKey, videoId } from '../video-workflow/watch-core.mjs';

const schema = 'progressive-reading.video-discovery/v1';
const macHost = 'mac-mini-tailscale';
const scheduledCycle = /^scheduled-\d{4}-\d{2}-\d{2}$/u;
const stableBvid = /^BV[0-9A-Za-z]{10}$/u;
const maxBytes = 4 * 1024 * 1024;
const hash = value => digest(JSON.stringify(value));
const fail = reason => { throw Error('video_discovery_' + reason); };
const safeCode = message => /^video_discovery_[a-z_]+$/u.test(message || '') ? message : 'video_discovery_unavailable';
const positiveInt = n => Number.isSafeInteger(n) && n > 0;
const itemFields = new Set(['key','bvid','cid','part','parts','video_title','part_title','duration','url','published_at']);
const projectWatch = watch => ({bvid:videoId(watch.url),collection:watch.collection !== false,season_id:watch.season_id ?? null});

function validateRequest(request) {
  if (request?.schema !== schema || !scheduledCycle.test(request.cycle || '') || !Number.isSafeInteger(request.revision) ||
      request.revision < 0 || !Array.isArray(request.watches) || !request.watches.length || request.watches.length > 30 ||
      request.watches.some(watch=>!stableBvid.test(watch?.bvid || '') || typeof watch.collection !== 'boolean' ||
        (watch.season_id !== null && !positiveInt(watch.season_id)))) fail('invalid_request');
}

function validateResult(watch, result) {
  const {found,trace} = result ?? {};
  if (!found || !Array.isArray(found.items) || !found.items.length ||
      (watch.collection ? !positiveInt(found.season_id) : found.season_id !== null) ||
      (watch.season_id !== null && watch.season_id !== found.season_id) ||
      !Array.isArray(trace?.viewBvids) || trace.viewBvids[0] !== watch.bvid ||
      new Set(trace.viewBvids).size !== trace.viewBvids.length ||
      (!watch.collection && trace.viewBvids.length !== 1) || !Array.isArray(trace.archivePages)) fail('invalid_result');

  const groups = new Map();
  const keys = new Set();
  let lastBvid;
  for (const item of found.items) {
    if (!stableBvid.test(item?.bvid || '') || !positiveInt(item.cid) || !positiveInt(item.part) || !positiveInt(item.parts) ||
        item.key !== itemKey(item.bvid,item.cid) || item.url !== canonicalUrl(item.bvid,item.part) || keys.has(item.key) ||
        typeof item.video_title !== 'string' || typeof item.part_title !== 'string' || !Number.isFinite(item.duration) || item.duration < 0 ||
        (item.published_at !== undefined && (typeof item.published_at !== 'string' || !Number.isFinite(Date.parse(item.published_at)))) ||
        !Object.keys(item).every(key=>itemFields.has(key))) fail('invalid_item');
    const group = groups.get(item.bvid);
    if ((!group && item.part !== 1) || (group && (lastBvid !== item.bvid || item.part !== group.last + 1 || item.parts !== group.parts)))
      fail('part_order_mismatch');
    groups.set(item.bvid,{last:item.part,parts:item.parts});
    keys.add(item.key);
    lastBvid=item.bvid;
  }
  if (JSON.stringify([...groups.keys()]) !== JSON.stringify(trace.viewBvids) ||
      [...groups.values()].some(row=>row.last !== row.parts)) fail('incomplete_parts');

  let rows=0;
  const total=trace.archivePages[0]?.total;
  for (const [index,page] of trace.archivePages.entries()) {
    if (!watch.collection || page?.page !== index+1 || !positiveInt(page.rows) || !positiveInt(total) ||
        page.rows > 30 || page.total !== total || rows >= total) fail('incomplete_pagination');
    rows+=page.rows;
  }
  if (trace.archivePages.length && (rows !== total || ![total,total+1].includes(groups.size))) fail('incomplete_pagination');
}

export async function generateVideoDiscovery(request, api = biliApi) {
  validateRequest(request);
  const results = [];
  for (const watch of request.watches) {
    const trace={viewBvids:[],archivePages:[]};
    const found=await discover({...watch,url:canonicalUrl(watch.bvid)},{api:async endpoint=>{
      const data=await api(endpoint);
      const view=/^x\/web-interface\/view\?bvid=(BV[0-9A-Za-z]{10})$/u.exec(endpoint);
      if (view) trace.viewBvids.push(view[1]);
      else {
        const params=new URLSearchParams(endpoint.split('?')[1]);
        trace.archivePages.push({page:Number(params.get('page_num')),total:Number(data.page?.total),rows:data.archives?.length});
      }
      return data;
    }});
    const result={found,trace};
    validateResult(watch,result);
    results.push(result);
  }
  return {schema,requestSha256:hash(request),resultSha256:hash(results),results};
}

export function verifyVideoDiscovery(request, response) {
  validateRequest(request);
  const results=response?.results;
  if (response?.schema !== schema || response.requestSha256 !== hash(request) || !Array.isArray(results) ||
      results.length !== request.watches.length || response.resultSha256 !== hash(results)) fail('receipt_mismatch');
  results.forEach((result,index)=>validateResult(request.watches[index],result));
  return results;
}

function requestMac(binding, request) {
  const command='exec '+binding.home+'/.local/bin/node '+binding.home+
    '/Agent/Projects/progressive-reading-workflow/subscription-workflow/video-discovery-stage.mjs';
  return new Promise((resolve,reject)=>{
    const child=execFile('ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no',
      '-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','ConnectTimeout=4',macHost,command],
      {windowsHide:true,timeout:95000,maxBuffer:maxBytes},(error,stdout,stderr)=>{
        if (error) return reject(Error(safeCode(stderr?.trim())));
        try { resolve(JSON.parse(stdout)); } catch { reject(Error('video_discovery_invalid_response')); }
      });
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(request));
  });
}

export async function boundVideoDiscovery(home,cycle,revision,watches,{send=requestMac}={}) {
  if (!scheduledCycle.test(cycle) || !watches.length) return null;
  try {
    const binding=await readJson(path.join(home,'remote-video-discovery.json'));
    if (binding?.enabled !== true) return null;
    if (binding.host !== macHost || !/^\/Users\/[A-Za-z0-9_-]+$/u.test(binding.home || '')) fail('invalid_binding');
    const request={schema,cycle,revision,watches:watches.map(projectWatch)};
    validateRequest(request);
    const response=await send(binding,request);
    const results=verifyVideoDiscovery(request,response);
    const bySource=new Map(watches.map((watch,index)=>[watch.subscription_id,results[index]]));
    return {bySource,receipt:{executor:'mac',cycle,sourceCount:results.length,
      requestSha256:response.requestSha256,resultSha256:response.resultSha256,
      views:results.reduce((sum,result)=>sum+result.trace.viewBvids.length,0),
      archivePages:results.reduce((sum,result)=>sum+result.trace.archivePages.length,0)}};
  } catch(error) {
    return {bySource:null,receipt:{executor:'windows',cycle,fallback:safeCode(error?.message)}};
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    let input='';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input+=chunk;
      if (input.length>64*1024) fail('request_too_large');
    }
    const response=await generateVideoDiscovery(JSON.parse(input.replace(/^\uFEFF/u,'')));
    console.log(JSON.stringify(response));
  } catch(error) {
    console.error(safeCode(error?.message));
    process.exitCode=1;
  }
}
