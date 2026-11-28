import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {dataPath} from '../scripts/runtime-paths.mjs';
import {digest,paths,readJson,withLock} from '../subscription-workflow/config.mjs';
import {biliApi,canonicalUrl,itemKey} from './watch-core.mjs';

const schema='progressive-reading.watch-subtitles/v1';
const host='mac-mini-tailscale';
const maximumBytes=4*1024*1024;
const execute=promisify(execFile);
const chinaTrack=/^(?:ai-zh|zh(?:[-_][A-Za-z0-9]+)*)$/u;
const cdnHosts=new Set(['aisubtitle.hdslb.com','i0.hdslb.com','i1.hdslb.com','i2.hdslb.com']);
const script=path.join(import.meta.dirname,'../subscription-workflow/zhihu-chrome-tab.applescript');
const fail=reason=>{throw Error('watch_subtitles_'+reason);};
const timestamp=seconds=>[Math.floor(seconds/3600),Math.floor(seconds/60)%60,Math.floor(seconds)%60]
  .map(unit=>String(unit).padStart(2,'0')).join(':');

function verifyRequest(request) {
  const {bvid,cid,part,parts,duration}=request || {};
  if (request?.schema!==schema || !/^BV[A-Za-z0-9]{10}$/u.test(bvid || '') || !Number.isSafeInteger(cid) || cid<1 ||
      !Number.isSafeInteger(part) || part<1 || !Number.isSafeInteger(parts) || parts<part ||
      !Number.isFinite(duration) || duration<=0) fail('invalid_request');
}

function verifyTimeline(rows,duration) {
  const edge=Math.min(10,Math.max(1,duration*0.015)), gapLimit=Math.min(35,duration*0.15);
  if (!Array.isArray(rows) || !rows.length) fail('missing_track');
  let lastStart=0, tail=0, captioned=0;
  const segments=rows.map(row=>{
    const {from,to,content}=row || {};
    if (!Number.isFinite(from) || !Number.isFinite(to) || from<lastStart || to<=from ||
        to>duration+2 || typeof content!=='string' || !content.trim()) fail('invalid_timeline');
    if (from-tail>(tail ? gapLimit : edge)) fail('incomplete_timeline');
    lastStart=from;
    captioned+=Math.max(0,to-Math.max(tail,from));
    tail=Math.max(tail,to);
    // The original subtitle-only adapter converts Bilibili's SRT to whole seconds.
    return { start:timestamp(from),end:timestamp(to),text:content.split(/\r?\n/u).map(line=>line.trim()).filter(Boolean).join(' ') };
  });
  if (duration-tail>edge || captioned<duration*0.9) fail('incomplete_timeline');
  return {segments,first:rows[0].from,last:tail};
}

function sourceChapters(points,duration) {
  if (points==null) return [];
  if (!Array.isArray(points)) fail('invalid_chapters');
  return points.map(row=>{
    const {content,from,to}=row || {};
    if (typeof content!=='string' || !Number.isFinite(from) || !Number.isFinite(to) ||
        from<0 || to<from || to>duration+2) fail('invalid_chapters');
    return {title:content,start_time:from,end_time:to};
  });
}

export async function readWatchSubtitleTrack(request,readPage,api=biliApi) {
  verifyRequest(request);
  const {bvid,cid,part,parts,duration}=request;
  const view=await api('x/web-interface/view?bvid='+bvid);
  const page=view.pages?.find(entry=>entry.page===part);
  if (view.bvid!==bvid || page?.cid!==cid || view.pages.length!==parts ||
      !Number.isFinite(page.duration || view.duration) || Math.abs((page.duration || view.duration)-duration)>1) fail('part_mismatch');
  const account=await readPage('https://api.bilibili.com/x/web-interface/nav');
  if (account?.data?.isLogin!==true) fail('chrome_signed_out');
  const player=await readPage('https://api.bilibili.com/x/player/wbi/v2?bvid='+bvid+'&cid='+cid);
  if (player?.code!==0 || player.data?.cid!==cid || player.data.need_login_subtitle===true) fail('player_part_unconfirmed');
  const tracks=player.data.subtitle?.subtitles;
  const track=Array.isArray(tracks) && tracks.find(row=>chinaTrack.test(row.lan || '') && row.subtitle_url);
  if (!track) fail('missing_track');
  // Navigate within the same session to the exact resource offered by the player.
  // The expiring address stays in the worker and is not part of its receipt.
  const url=new URL(track.subtitle_url,'https://api.bilibili.com');
  if (url.protocol!=='https:' || !cdnHosts.has(url.hostname) || url.port || url.username || url.password || url.hash ||
      !/^\/bfs\/(?:ai_)?subtitle\/(?:[0-9A-Za-z_.-]+\/)*[0-9A-Za-z_.-]+$/u.test(url.pathname)) fail('unexpected_caption_resource');
  const payload=await readPage(url.href);
  const rows=Array.isArray(payload?.body) ? payload.body.map(({from,to,content})=>({from,to,content})) : null;
  verifyTimeline(rows,duration);
  const chapters=sourceChapters(player.data.view_points,duration);
  const points=chapters.map(({title,start_time,end_time})=>({content:title,from:start_time,to:end_time}));
  const trackData={language:track.lan,rows,points};
  return {schema,requestSha256:digest(JSON.stringify(request)),track:trackData,trackSha256:digest(JSON.stringify(trackData))};
}

async function readChromePage(url) {
  const root=dataPath('ProgressiveReading','ZhihuDiscovery');
  const directory=await fs.mkdtemp(path.join(root,'video-subtitle-'));
  const file=path.join(directory,'response.html');
  try {
    await execute('/usr/bin/osascript',[script,url,file],{timeout:26000,maxBuffer:8192});
    if((await fs.stat(file)).size>maximumBytes) fail('response_too_large');
    return JSON.parse(await fs.readFile(file,'utf8'));
  } finally {
    await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await fs.rmdir(directory);
  }
}

function exchange(binding,request) {
  const command=`exec /usr/bin/env PROGRESSIVE_READING_DATA_HOME=${binding.home}/Agent/AppData ${binding.home}/.local/bin/node ${binding.home}/Agent/Projects/progressive-reading-workflow/video-workflow/watch-subtitle-stage.mjs`;
  return new Promise((resolve,reject)=>{
    const child=execFile('ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no',
      '-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','ConnectTimeout=5',host,command],
      {windowsHide:true,timeout:85000,maxBuffer:maximumBytes},(error,stdout,stderr)=>{
        const reason=stderr?.trim();
        if (error) return reject(Error(/^watch_subtitles_[a-z_]+$/u.test(reason || '') ? reason : 'watch_subtitles_mac_unavailable'));
        try { resolve(JSON.parse(stdout)); } catch { reject(Error('watch_subtitles_invalid_response')); }
      });
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(request));
  });
}

const exists=file=>fs.stat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});

export async function adoptWatchSubtitleTrack(workflowRoot,item,watch,jobDir,{send=exchange}={}) {
  const sourceDir=path.join(jobDir,'source');
  if (!watch.subscription_id || await exists(sourceDir)) return null;
  const binding=await readJson(path.join(paths(workflowRoot).home,'remote-video-media.json')).catch(()=>null);
  if (binding?.enabled!==true || binding.fetchSubtitles!==true || binding.host!==host ||
      !/^\/Users\/[A-Za-z0-9_-]+$/u.test(binding.home || '')) return null;
  const {bvid,cid,part,parts,duration,url}=item;
  const request={schema,bvid,cid,part,parts,duration};
  let track,span,chapters,result;
  try {
    verifyRequest(request);
    if (url!==canonicalUrl(bvid,part) || item.key!==itemKey(bvid,cid)) fail('part_mismatch');
    result=await send(binding,request);
    ({track}=result);
    if (result.schema!==schema || result.requestSha256!==digest(JSON.stringify(request)) ||
        result.trackSha256!==digest(JSON.stringify(track)) || !chinaTrack.test(track?.language || '')) fail('receipt_mismatch');
    span=verifyTimeline(track.rows,duration);
    chapters=sourceChapters(track.points,duration);
  } catch(error) {
    const reason=/^watch_subtitles_[a-z_]+$/u.test(error.message) ? error.message : 'watch_subtitles_mac_unavailable';
    console.log(JSON.stringify({event:'subscription_video_subtitles',executor:'windows',key:item.key,fallback:reason}));
    return null;
  }
  const title=path.basename(item.publish_path,'.md').replace(/（强结构化整理）$/u,'');
  const transcript={video_id:bvid+'_p'+part,video_url:url,source_url:url,title,duration,cid,segments:span.segments,chapters};
  const metadata={source_url:url,canonical_url:url,title,source_id:transcript.video_id,source_platform:'Bilibili',language:'zh',
    subtitle_file:'transcript.json',media_downloaded:false,asr_used:false,subtitle_kind:'platform_subtitles',bvid,cid,part,
    subtitle_executor:'mac_native_chrome',track_language:track.language,track_sha256:result.trackSha256};
  await fs.mkdir(jobDir,{recursive:true});
  const staging=await fs.mkdtemp(path.join(jobDir,'.mac-subtitles-'));
  try {
    for (const [name,value] of [['transcript.json',transcript],['source.json',metadata]]) {
      await fs.writeFile(path.join(staging,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    }
    if (await exists(sourceDir)) return null;
    await fs.rename(staging,sourceDir);
  } finally {
    // Only the newly allocated staging directory may need cleanup.
    for (const name of ['source.json','transcript.json']) {
      await fs.unlink(path.join(staging,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
    await fs.rmdir(staging).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  console.log(JSON.stringify({event:'subscription_video_subtitles',executor:'mac',key:item.key,trackSha256:result.trackSha256,
    segments:span.segments.length,first:span.first,last:span.last,duration}));
  return {sourceDir};
}

if (process.argv[1] && path.resolve(process.argv[1])===import.meta.filename) {
  try {
    process.umask(0o077);
    if(process.platform!=='darwin') fail('mac_required');
    let wire='';
    for await(const chunk of process.stdin.setEncoding('utf8')) {
      wire+=chunk;
      if(wire.length>2048) fail('invalid_request');
    }
    const lock=dataPath('ProgressiveReading','ZhihuDiscovery','chrome.lock');
    const output=JSON.stringify(await withLock(lock,()=>readWatchSubtitleTrack(JSON.parse(wire),readChromePage)));
    if(Buffer.byteLength(output)>maximumBytes) fail('response_too_large');
    console.log(output);
  } catch(error) {
    console.error(/^watch_subtitles_[a-z_]+$/u.test(error.message) ? error.message : 'watch_subtitles_mac_unavailable');
    process.exitCode=1;
  }
}
