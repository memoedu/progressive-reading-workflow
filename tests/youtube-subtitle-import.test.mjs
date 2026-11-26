import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchYoutubeSubtitleDraft, selectSubtitleTrack, subtitleIntegrity, youtubeCookieFile } from '../scripts/youtube-subtitle-import.mjs';
import { youtubeVideoIdentity, urlImportDedupeKey } from '../scripts/url-import-input.mjs';
import { parseVtt, groupTranscriptSegments } from '../scripts/import-youtube-subtitle-canary.mjs';

const id = 'aB1cD2eF3gH';
const url = `https://www.youtube.com/watch?v=${id}`;
const formats = [{ ext: 'vtt', url: 'https://www.youtube.com/api/timedtext?lang=zh-Hans' }];
const info = { id, title: '独立合成字幕样例', duration: 150, subtitles: { 'zh-Hans': formats } };
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:01:00.000\n' + '这个合成样例说明来源文字应完整保留。'.repeat(5)
  + '\n\n00:01:00.000 --> 00:02:29.000\n' + '第二部分保留条件、例子与推理过程。'.repeat(5) + '\n';

test('video aliases share one identity; playlists and lookalike hosts are rejected', () => {
  for (const candidate of [url + '&list=abc&t=5', `https://youtu.be/${id}?si=tracking`, `https://m.youtube.com/shorts/${id}`]) assert.equal(urlImportDedupeKey(candidate), url);
  for (const candidate of ['https://youtube.com/playlist?list=123', `https://youtube.com.evil.test/watch?v=${id}`]) assert.equal(youtubeVideoIdentity(candidate), null);
});
test('track selection prefers manual captions and excludes automatic translations', () => {
  assert.equal(selectSubtitleTrack({ ...info, automatic_captions: { en: formats } }).kind, 'manual');
  assert.equal(selectSubtitleTrack({ automatic_captions: { en: formats } }).kind, 'automatic');
  assert.equal(selectSubtitleTrack({ automatic_captions: { zh: [{ ext: 'vtt', url: 'https://www.youtube.com/api/timedtext?tlang=zh' }] } }), null);
  assert.equal(selectSubtitleTrack({}), null);
});

test('a video without captions enters the same intake with verified audio and timestamps', async () => {
  const base = 'D:/Artifacts/ProgressiveReading/youtube-restore/tests';
  await fs.mkdir(base,{recursive:true});
  const root = await fs.mkdtemp(path.join(base,'asr-'));
  const authRoot = path.join(root,'auth');
  const liveSnapshot = {dataRoot:authRoot,jar:{cookies:[]},headerForUrl:()=>null,
    protectDirectory:()=>fs.mkdir(authRoot,{recursive:true})};
  const audio = Buffer.from('fixture audio'), stages = [];
  const settings = {artifactRoot:root,liveSnapshot,onProgress:event=>stages.push(event.stage),runYtDlp:async args=>{
    if (args.includes('--dump-single-json')) return JSON.stringify({...info,subtitles:{},language:''});
    assert.equal(args.at(-1),url);
    assert.equal(args[args.indexOf('--format')+1],'bestaudio');
    assert.ok(args.includes('--extract-audio'));
    assert.ok(!args.includes('--skip-download') && !args.includes('--write-subs'));
    await fs.writeFile(path.join(root,id,`${id}.m4a`),audio);
    return `${id}|150\n`;
  }};
  const utterances = [{start_ms:1250,end_ms:60000,text:'合成字幕验证逐句来源。'.repeat(9)},
    {start_ms:110000,end_ms:149000,text:'时间轴覆盖视频尾部。'.repeat(7)}];
  const result = await fetchYoutubeSubtitleDraft(url,{...settings,transcribe:async (input,output)=>{
    assert.equal(input.sha256,createHash('sha256').update(audio).digest('hex'));
    assert.equal(output,path.join(root,id,'asr'));
    return {utterances,route:'fixture'};
  }});
  assert.deepEqual(stages,['youtube_metadata','youtube_audio','youtube_transcription','youtube_standard_preprocess']);
  assert.equal(result.segments[0].start,'00:00:01.250');
  assert.equal(result.fetchReceipt.asr_used,true);
  assert.equal(result.draft.sourceMetadata.subtitle_kind,'audio_transcription');
  assert.equal(Object.hasOwn(result.draft.sourceMetadata,'language'),false);
  assert.equal(result.fetchReceipt.subtitle_language,null);
  assert.equal(result.fetchReceipt.content_integrity.last_caption_seconds,149);
  await assert.rejects(fetchYoutubeSubtitleDraft(url,{...settings,
    transcribe:async()=>({utterances:utterances.slice(0,1),route:'fixture'})}),/timeline_incomplete/u);
  assert.deepEqual(await fs.readdir(authRoot),[]);
});
test('existing VTT parser and grouping preserve all parsed text and reject truncated tracks', () => {
  const segments = parseVtt(vtt), paragraphs = groupTranscriptSegments(segments);
  assert.equal(subtitleIntegrity(segments, paragraphs, 150, vtt).text_coverage, 1);
  assert.throws(() => subtitleIntegrity(segments, paragraphs.slice(1), 150, vtt), /text_coverage/u);
  assert.throws(() => subtitleIntegrity(segments, paragraphs, 1000, vtt), /timeline_incomplete/u);
});
test('cookie bridge is domain scoped and preserves expiry/host-only attributes', () => {
  const cookie = { domain: 'youtube.com', hostOnly: false, path: '/', secure: true, session: true, name: 'fixture', value: 'synthetic-value' };
  const body = youtubeCookieFile([cookie, { ...cookie, domain: 'private.test' }, { ...cookie, name: 'expired', session: false, expirationDate: 1 }]);
  assert.match(body, /\.youtube\.com\tTRUE/u);
  assert.doesNotMatch(body, /private\.test|expired/u);
});
test('adapter calls existing parser, uses subtitles only, sanitizes artifacts and removes ephemeral credentials', async () => {
  const base = 'D:/Artifacts/ProgressiveReading/youtube-restore/tests';
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'adapter-'));
  const authRoot = path.join(root, 'auth');
  const liveSnapshot = { dataRoot: authRoot, jar: { cookies: [] }, headerForUrl: () => null,
    protectDirectory: () => fs.mkdir(authRoot, { recursive: true }) };
  let calls = 0;
  const runYtDlp = async args => {
    calls++;
    assert.ok(args.includes('--skip-download'));
    assert.ok(args.includes('--no-playlist'));
    if (args.includes('--dump-single-json')) return JSON.stringify({ ...info, secret_fixture: 'must-never-be-persisted' });
    assert.ok(args.includes('--write-subs'));
    assert.ok(!args.includes('--write-auto-subs'));
    await fs.writeFile(path.join(root, id, `${id}.zh-Hans.vtt`), vtt);
    return '';
  };
  const fetched = await fetchYoutubeSubtitleDraft(url, { artifactRoot: root, liveSnapshot, runYtDlp });
  assert.equal(calls, 2);
  assert.equal(fetched.draft.pageText, groupTranscriptSegments(parseVtt(vtt)).map(item => item.text).join('\n\n'));
  assert.equal(fetched.draft.sourceMetadata.input_form, 'spoken_transcript');
  assert.equal(fetched.fetchReceipt.asr_used, false);
  assert.doesNotMatch(await fs.readFile(path.join(root, id, 'source.json'), 'utf8'), /must-never-be-persisted|timedtext/u);
  assert.deepEqual(await fs.readdir(authRoot), []);
  await assert.rejects(fetchYoutubeSubtitleDraft(url, { artifactRoot: root, liveSnapshot, runYtDlp: async () => { throw new Error('fixture_failure'); } }), /fixture_failure/u);
  assert.deepEqual(await fs.readdir(authRoot), []);
  let authAttempts = 0;
  const authenticated = await fetchYoutubeSubtitleDraft(url, {
    artifactRoot: root, liveSnapshot: { ...liveSnapshot, headerForUrl: () => 'fixture=synthetic' },
    runYtDlp: async args => {
      authAttempts++;
      if (!args.includes('--cookies')) throw new Error('youtube_login_required');
      return runYtDlp(args);
    }
  });
  assert.equal(authAttempts, 3, 'one public probe, one authenticated probe, then caption download');
  assert.equal(authenticated.fetchReceipt.acquisition_mode, 'chrome_live_snapshot');
  assert.deepEqual(await fs.readdir(authRoot), []);
});
