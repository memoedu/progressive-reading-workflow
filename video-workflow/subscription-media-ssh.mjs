import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {digest,paths,readJson,withLock,writeJson} from '../subscription-workflow/config.mjs';
import {diagnoseCodex} from '../standard-preprocessing/lib/codex-exec.mjs';
import {loadBatchProducerConfig} from '../standard-preprocessing/lib/producer.mjs';

const schema = 'progressive-reading.subscription-video-media/v1';
const maximumBytes = 8 * 1024 * 1024;
const planner = path.join(import.meta.dirname,'plan-upstream-media.py');
const execute = promisify(execFile);
const codePaths = [
  'video-workflow/subscription-media-ssh.mjs',
  'video-workflow/plan-upstream-media.py',
  'video-workflow/prompts/upstream-media-only.md',
  'video-workflow/upstream/prompts/stitcher_system.md',
  'video-workflow/upstream/skills/videobook/references/writing.md',
  'standard-preprocessing/producer_transport.py',
  'standard-preprocessing/producer-text.mjs',
  'standard-preprocessing/lib/producer.mjs',
  'standard-preprocessing/lib/codex-exec.mjs',
];
const validModel = model => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,70}$/u.test(model || '');

async function implementationSha() {
  const hashes = await Promise.all(codePaths.map(async file => digest(await fs.readFile(path.join(import.meta.dirname,'..',file)))));
  return digest(JSON.stringify([schema,...hashes]));
}

function portableTranscript(value, itemKey) {
  const key = /^bilibili:(BV[0-9A-Za-z]{10}):(\d+)$/u.exec(itemKey);
  const exactKeys = (object,fields) => object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).every(key => fields.includes(key));
  if (!key || !exactKeys(value,['video_id','video_url','source_url','title','duration','cid','segments','chapters'])) return false;
  const part = new RegExp(`^${key[1]}_p([1-9][0-9]*)$`,'u').exec(value.video_id)?.[1];
  const url = `https://www.bilibili.com/video/${key[1]}/${part === '1' ? '' : '?p='+part}`;
  return Boolean(part && String(value.cid) === key[2] && value.video_url === url && value.source_url === url
    && typeof value.title === 'string' && Number.isFinite(value.duration) && value.duration > 0
    && value.segments?.length > 0 && Array.isArray(value.segments) && value.segments.every(row =>
      exactKeys(row,['start','end','text']) && [row.start,row.end,row.text].every(field => typeof field === 'string'))
    && Array.isArray(value.chapters) && value.chapters.every(row => exactKeys(row,['title','start_time','end_time'])
      && typeof row.title === 'string' && Number.isFinite(row.start_time) && Number.isFinite(row.end_time)));
}

function remoteCommand(binding) {
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/u.test(binding?.host || '') ||
      !/^\/Users\/[A-Za-z0-9._-]+$/u.test(binding?.home || '')) throw Error('video_media_binding_invalid');
  return `exec ${binding.home}/.local/bin/node ${binding.home}/Agent/Projects/progressive-reading-workflow/video-workflow/subscription-media-ssh.mjs`;
}

function exchange(binding,wire,timeout) {
  return new Promise((resolve,reject) => {
    const child=execFile('ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
      '-o','UpdateHostKeys=no','-o','ForwardAgent=no','-o','ClearAllForwardings=yes',
      '-o','ConnectTimeout=6','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3',
      binding.host,remoteCommand(binding)],{windowsHide:true,timeout,maxBuffer:maximumBytes},(error,stdout) => {
      if (error) reject(Error('video_media_ssh_no_confirmed_result'));
      else resolve(stdout);
    });
    child.stdin.on('error',() => {});
    child.stdin.end(wire);
  });
}

function checkedResult(result,request,requestSha256) {
  if (result?.schema !== schema || result.requestSha256 !== requestSha256
      || result.resultSha256 !== digest(JSON.stringify([result.plan,result.planner]))
      || !Array.isArray(result.plan?.items) || !result.plan.items.length
      || result.planner?.status !== 'completed' || result.planner.input_sha256 !== request.subtitleSha256
      || result.planner.provider !== 'codex_exec' || result.planner.model !== request.model
      || result.planner.api_calls_total !== 1) throw Error('video_media_stage_result_mismatch');
  return result.plan;
}

export async function boundSubscriptionMediaPlanner({root,item,watch,inputDir,outputDir,send=exchange}) {
  const directory=path.join(outputDir,'media-planning');
  const dispatchFile=path.join(directory,'request-sent.json');
  const resultFile=path.join(directory,'ssh-result.json');
  const dispatched=await readJson(dispatchFile);
  const previous=dispatched?.executor==='mac' ? dispatched : null;
  const config=previous?.binding || await readJson(path.join(paths(root).home,'remote-video-media.json'));
  if (!config || (!previous && config.enabled !== true)) return undefined;
  remoteCommand(config);
  if (!previous && await fs.stat(directory).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  })) return undefined; // Local or undecided historical attempt owns its existing media files.
  const file=path.join(inputDir,'transcript.json');
  const raw=await fs.readFile(file,'utf8');
  const parsed=JSON.parse(raw);
  if (!validModel(watch.model) || !portableTranscript(parsed,item.key)) {
    if (previous) throw Error('video_media_dispatched_transcript_changed');
    return undefined;
  }
  const implementation=await implementationSha();
  const request={schema,op:'plan',implementation:previous?.implementation || implementation,
    key:item.key,model:watch.model,subtitleSha256:digest(raw),transcript:raw};
  const wire=JSON.stringify(request);
  const requestSha256=digest(wire);
  if (Buffer.byteLength(wire)>maximumBytes) {
    if (previous) throw Error('video_media_dispatched_transcript_changed');
    return undefined;
  }
  if (previous && previous.requestSha256 !== requestSha256) throw Error('video_media_dispatch_version_changed');
  if (!previous) {
    try {
      const probe=JSON.parse(await send(config,JSON.stringify({schema,op:'probe',implementation}),10000));
      if (probe.schema!==schema || probe.implementation!==implementation || probe.status!=='ready') throw Error('incompatible_worker');
    } catch {
      // No computation request was issued. The original local producer can take this attempt.
      return undefined;
    }
  }
  return async transcript => {
    if (JSON.stringify(transcript)!==JSON.stringify(parsed)) throw Error('video_media_subtitle_changed_before_dispatch');
    const saved=await readJson(resultFile);
    if (saved) return checkedResult(saved,request,requestSha256);
    const current=await readJson(dispatchFile);
    if (!current) {
      // The original local producer also refuses to send again if this marker exists.
      await writeJson(dispatchFile,{requests_sent:1,executor:'mac',requestSha256,implementation,
        binding:{host:config.host,home:config.home}});
    } else if (current.executor!=='mac' || current.requestSha256!==requestSha256) {
      throw Error('video_media_attempt_already_owned');
    }
    const result=JSON.parse(await send(config,wire,32*60*1000));
    const plan=checkedResult(result,request,requestSha256);
    if (digest(await fs.readFile(file))!==request.subtitleSha256) throw Error('video_media_subtitle_changed_before_adoption');
    await writeJson(resultFile,{...result,executor:'mac'});
    console.log(JSON.stringify({event:'subscription_video_media',executor:'mac',key:item.key,
      requestSha256,resultSha256:result.resultSha256}));
    return plan;
  };
}

export async function runSubscriptionMediaWorker(wire,{cache,python,run=execute}={}) {
  const request=JSON.parse(wire);
  const implementation=await implementationSha();
  if (request.schema!==schema) throw Error('video_media_worker_version_mismatch');
  if (request.op==='probe') {
    if (request.implementation!==implementation) throw Error('video_media_worker_version_mismatch');
    await fs.access(python);
    if (!(await diagnoseCodex(await loadBatchProducerConfig())).ready) throw Error('video_media_worker_producer_unavailable');
    return {schema,implementation,status:'ready'};
  }
  if (request.op!=='plan' || !validModel(request.model) ||
      typeof request.transcript!=='string' || digest(request.transcript)!==request.subtitleSha256
      || !portableTranscript(JSON.parse(request.transcript),request.key)) throw Error('video_media_worker_request_invalid');
  const requestSha256=digest(wire);
  const directory=path.join(cache,requestSha256);
  return withLock(path.join(directory,'worker.lock'),async () => {
    const file=path.join(directory,'ssh-result.json');
    const previous=await readJson(file);
    if (previous) {
      checkedResult(previous,request,requestSha256);
      return previous;
    }
    if (request.implementation!==implementation) throw Error('video_media_worker_version_mismatch');
    const transcript=path.join(directory,'transcript.json');
    await fs.writeFile(transcript,request.transcript,{flag:'wx',mode:0o600}).catch(async error => {
      if (error.code!=='EEXIST' || digest(await fs.readFile(transcript))!==request.subtitleSha256) throw error;
    });
    const output=path.join(directory,'media-planning');
    const env={...process.env,AI_PRODUCER_PROVIDER:'codex_exec',AI_PRODUCER_CODEX_MODEL:request.model,
      AI_PRODUCER_TIMEOUT_MS:'1800000',PR_READING_NODE:process.execPath,
      AI_PRODUCER_CODEX_WORK_DIR:path.join(homedir(),'Agent','Caches','ProgressiveReading','codex-exec')};
    await run(python,['-u',planner,'--input',transcript,'--output',output],
      {env,windowsHide:true,maxBuffer:maximumBytes});
    const plan=await readJson(path.join(output,'plan.json'));
    const receipt=await readJson(path.join(output,'receipt.json'));
    const result={schema,requestSha256,resultSha256:digest(JSON.stringify([plan,receipt])),plan,planner:receipt};
    checkedResult(result,request,requestSha256);
    await writeJson(file,result);
    return result;
  });
}

if (process.argv[1] && path.resolve(process.argv[1])===import.meta.filename) {
  process.umask(0o077);
  try {
    let length=0;
    const chunks=[];
    for await (const chunk of process.stdin) {
      length+=chunk.length;
      if (length>maximumBytes) throw Error('video_media_request_too_large');
      chunks.push(chunk);
    }
    const home=path.join(homedir(),'Agent','AppData','ProgressiveReading');
    const cache=process.env.PROGRESSIVE_READING_VIDEO_MEDIA_HOME || path.join(home,'VideoMediaPlanning');
    const python=path.join(home,'VideoRuntime','venv','bin','python');
    const output=JSON.stringify(await runSubscriptionMediaWorker(Buffer.concat(chunks).toString('utf8'),{cache,python}));
    if (Buffer.byteLength(output)>maximumBytes) throw Error('video_media_result_too_large');
    process.stdout.write(output+'\n');
  } catch {
    process.stderr.write('video_media_worker_failed\n');
    process.exitCode=1;
  }
}
