import path from 'node:path';
import { readJson, writeJson } from './config.mjs';
import { fetchYoutubeSubtitleDraft } from '../scripts/youtube-subtitle-import.mjs';
import { LiveCookieSnapshot, defaultCookieDataRoot } from '../scripts/live-cookie-snapshot.mjs';
import { findSourcePublication } from '../scripts/reading-source-library.mjs';
import { entryPublication } from '../video-workflow/watch-core.mjs';
import { PROCESSING_OPTIONS, WATCH_ARTIFACTS, processTranscriptItem, processWatchItem } from '../video-workflow/watch-process.mjs';
import { watchJobDir } from '../video-workflow/watch-illustrated.mjs';

export async function runYoutubeVideo(root, request, watch, {
  onProgress = async () => {}, fetchDraft = fetchYoutubeSubtitleDraft,
  processTranscript = processTranscriptItem, processIllustrated = processWatchItem,
  existing = findSourcePublication, artifactRoot = WATCH_ARTIFACTS
} = {}) {
  const published = await existing(root,request.url);
  if (published) return {status:'completed',publication:published.path,reused:true};

  const jobDir = watchJobDir(artifactRoot,request,request.output_type);
  const sourceDir = path.join(jobDir,'source');
  const sourceFile = path.join(sourceDir,'source.json');
  const transcriptFile = path.join(sourceDir,'transcript.json');
  let transcript = await readJson(transcriptFile);
  let source = await readJson(sourceFile);
  if (!transcript || !source) {
    const liveSnapshot = new LiveCookieSnapshot({workflowRoot:root,dataRoot:defaultCookieDataRoot(root)});
    const {draft,segments} = await fetchDraft(request.url,{liveSnapshot,artifactRoot:path.join(jobDir,'captions'),onProgress});
    source = {...draft.sourceMetadata,subtitle_file:'transcript.json'};
    if (source.source_id !== request.video_id || source.canonical_url !== request.url) throw new Error('youtube_video_source_identity_mismatch');
    transcript = {video_id:request.video_id,video_url:request.url,title:draft.title,
      duration:source.duration || source.content_integrity.last_caption_seconds,segments};
    await writeJson(transcriptFile,transcript);
    await writeJson(sourceFile,source);
  }
  if (source.source_id !== request.video_id || source.canonical_url !== request.url
      || transcript.video_id !== request.video_id || transcript.video_url !== request.url) {
    throw new Error('youtube_video_source_identity_mismatch');
  }

  const illustrated = request.output_type === 'illustrated';
  const item = {...request,key:`youtube:${request.video_id}`,part:1,parts:1,video_title:transcript.title};
  item.publish_path = entryPublication(path.resolve(root,'阅读区',request.destination),item,illustrated ? '图文模式' : '字幕整理');
  const prepared = {sourceDir,jobDir};
  const result = illustrated
    ? await processIllustrated(item,watch,{artifactRoot,onProgress,prepareSource:async()=>prepared,
      processingOptions:{...PROCESSING_OPTIONS,source_language:source.language}})
    : await processTranscript(item,prepared);
  return {...result,title:transcript.title};
}
