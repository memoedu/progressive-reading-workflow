import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {digest,paths,writeJson} from '../subscription-workflow/config.mjs';
import {adoptWatchSubtitleTrack,readWatchSubtitleTrack} from '../video-workflow/watch-subtitle-stage.mjs';

const bvid='BV0000000001',cid=220,part=2,parts=2,duration=120;
const schema='progressive-reading.watch-subtitles/v1';
const request={schema,bvid,cid,part,parts,duration};
const url='https://www.bilibili.com/video/'+bvid+'/?p=2';
const item={bvid,cid,part,parts,duration,url,key:`bilibili:${bvid}:${cid}`,publish_path:'测试（强结构化整理）.md'};
const asset='https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/track?variant=a';
const complete=Array.from({length:60},(_,index)=>({from:index*2+0.08,to:index*2+2,content:'内容 '+index}));
const view={bvid,pages:[{cid:100,page:1,duration:20},{cid,page:part,duration}]};
const platform=(rows=complete,{responseCid=cid,resource=asset}={})=>async url=>{
  if (url.endsWith('/nav')) return {data:{isLogin:true}};
  if (url.includes('/x/player/wbi/v2')) return {code:0,data:{cid:responseCid,
    view_points:[{from:0,to:120,content:'章节',img:'must not transfer'}],
    subtitle:{subtitles:[{lan:'ai-en',subtitle_url:asset},{lan:'ai-zh',subtitle_url:resource}]}}};
  assert.equal(url,asset);
  return {body:rows};
};
const discover=async()=>view;

test('binds one normal platform track to exact BV and CID and projects only transcript evidence',async()=>{
  const result=await readWatchSubtitleTrack(request,platform(),discover);
  assert.equal(result.requestSha256,digest(JSON.stringify(request)));
  assert.equal(result.track.language,'ai-zh');
  assert.deepEqual(result.track.rows,complete);
  assert.deepEqual(result.track.points,[{content:'章节',from:0,to:120}]);
  await assert.rejects(readWatchSubtitleTrack(request,platform(complete,{responseCid:100}),discover),/player_part_unconfirmed/u);
  await assert.rejects(readWatchSubtitleTrack(request,platform(),async()=>({...view,bvid:'BV0000000002'})),/part_mismatch/u);
  await assert.rejects(readWatchSubtitleTrack(request,platform(complete,{resource:'https://example.invalid/track'}),discover),/unexpected_caption_resource/u);
});

test('a short ending, missing middle, and malformed cue order do not qualify',async()=>{
  for(const rows of [complete.slice(0,52),complete.filter((_,index)=>index<15 || index>=31),complete.slice(3)]) {
    await assert.rejects(readWatchSubtitleTrack(request,platform(rows),discover),/incomplete_timeline/u);
  }
  await assert.rejects(readWatchSubtitleTrack(request,platform([...complete].reverse()),discover),/invalid_timeline|incomplete_timeline/u);
});

test('adopts an exact pair once and leaves the original local path available after a failed response',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'watch-subtitles-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'data'), job=path.join(root,'job'), other=path.join(root,'fallback');
  await writeJson(paths(root).marker,{home});
  await writeJson(path.join(home,'remote-video-media.json'),{enabled:true,fetchSubtitles:true,host:'mac-mini-tailscale',home:'/Users/test'});
  const watch={subscription_id:'fixture'};
  let calls=0;
  const send=async(binding,received)=>{
    calls++;
    assert.deepEqual(received,request);
    return readWatchSubtitleTrack(received,platform(),discover);
  };
  const stored=await adoptWatchSubtitleTrack(root,item,watch,job,{send});
  assert.equal(stored.sourceDir,path.join(job,'source'));
  const get=async name=>JSON.parse(await fs.readFile(path.join(stored.sourceDir,name),'utf8'));
  const transcript=await get('transcript.json'), source=await get('source.json');
  assert.equal(source.subtitle_kind,'platform_subtitles');
  assert.equal(source.asr_used,false);
  assert.equal(transcript.video_id,bvid+'_p2');
  assert.deepEqual(transcript.segments[0],{start:'00:00:00',end:'00:00:02',text:'内容 0'});
  assert.equal(await adoptWatchSubtitleTrack(root,item,watch,job,{send}),null);
  assert.equal(calls,1);
  assert.equal(await adoptWatchSubtitleTrack(root,item,{},other,{send}),null);
  assert.equal(calls,1);
  const handoff=await send({},request);
  const clipped={...handoff.track,rows:complete.slice(0,25)};
  assert.equal(await adoptWatchSubtitleTrack(root,item,watch,other,{send:async()=>({
    ...handoff,track:clipped,trackSha256:digest(JSON.stringify(clipped))
  })}),null);
  await assert.rejects(fs.access(other),{code:'ENOENT'});
});
