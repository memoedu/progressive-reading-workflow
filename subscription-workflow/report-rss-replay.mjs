import fs from 'node:fs/promises';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {canonicalUrl,digest,readJson,withLock,writeJson} from './config.mjs';
import {materialKey} from './catalog.mjs';
import {includesPublication} from './history.mjs';
import {readCapturedFeeds} from './remote-feed-stage.mjs';
import {parseFeedDocument,syncFeedDocument} from '../rss-source/core.mjs';
import {fetchArticleContent,originalArticleTarget} from '../rss-source/article-fetch.mjs';
import {fetchText} from '../rss-source/cli.mjs';
import {LONG_THRESHOLD,prepareIsolatedReportPreview} from '../rss-reading/core.mjs';
import {meaningfulLength} from './content-length.mjs';

const hash=value=>digest(JSON.stringify(value));
const localDate=instant=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',dateStyle:'short'}).format(instant);
const absent=reason=>({status:'waiting_input',reason,items:[],pending:[]});

async function fetchBoundArticle(itemUrl,fetchPage) {
  const article=await fetchArticleContent(canonicalUrl(itemUrl),async (url,options)=>{
    const page=await fetchPage(url,{...options,redirect:'manual',timeoutMs:20000});
    if(materialKey(page.finalUrl)!==materialKey(url))throw Error('report_article_identity_changed');
    return page;
  });
  const dom=new JSDOM(article.html,{url:itemUrl});
  try {
    const allowed=new Set([itemUrl,originalArticleTarget(itemUrl)?.page].filter(Boolean).map(materialKey));
    const declared=dom.window.document.querySelector('link[rel~="canonical"][href],meta[property="og:url"][content]');
    if(declared && !allowed.has(materialKey(new URL(declared.getAttribute('href') || declared.getAttribute('content'),itemUrl).href))){
      throw Error('report_article_identity_changed');
    }
  } finally { dom.window.close(); }
  return article;
}

function blockedBodyReason(errors) {
  const reason=errors.find(error=>error.code==='fulltext_fetch_failed')?.message||'';
  if(reason==='report_article_identity_changed' || /^(?:http_30[12378]|original_article_(?:origin_changed|identity_or_access_invalid))/u.test(reason))
    return 'report_article_identity_unverified';
  if(/^(?:http_(?:401|403)|fetched_article_access_restricted)/u.test(reason))return 'report_article_access_restricted';
  if(/^(?:fetched_article_(?:looks_truncated|too_short)|rss_reader_page_missing_original)/u.test(reason))return 'report_article_body_incomplete';
  return 'report_article_body_unavailable';
}

export async function replayReportRss(home,plan,{preparePreview=prepareIsolatedReportPreview,fetchPage=fetchText}={}) {
  const checkpoint=plan.rssCheckpoint;
  if(!checkpoint)return absent('rss_checkpoint_missing');
  const rss=path.join(path.dirname(home),'SubscriptionFeedCapture',plan.cycle);
  const receipt=await readJson(path.join(rss,'receipt.json'));
  if(!receipt)return absent('rss_capture_missing');
  if(receipt.cycle!==plan.cycle || receipt.revision!==plan.revision ||
     !['completed','completed_with_issues'].includes(receipt.status) || !receipt.verified ||
     !Number.isSafeInteger(receipt.feeds) || receipt.feeds<1 || receipt.feeds+receipt.failed!==checkpoint.sources.length)
    return absent('rss_capture_incomplete_or_wrong_revision');
  const capture=await readCapturedFeeds(path.join(rss,'capture.json'),plan.cycle,
    {enabled:true,revision:plan.revision,subscriptions:checkpoint.sources}).catch(()=>null);
  if(!capture || capture.sha256!==receipt.sha256 || capture.fetchedAt!==receipt.finishedAt ||
    capture.completed!==receipt.feeds || capture.failed!==receipt.failed ||
    (capture.failed===0)!==(receipt.status==='completed') ||
    !Number.isFinite(Date.parse(capture.fetchedAt)) || localDate(new Date(capture.fetchedAt))!==plan.cycle.slice(10))
    return absent('rss_capture_integrity_failed');
  const known=new Set(checkpoint.knownKeys);
  const work=path.join(home,'rss-replay',plan.cycle,hash([plan.revision,capture.sha256,checkpoint]));
  return withLock(path.join(work,'replay.lock'),async()=>{
    const savedFile=path.join(work,'result.json');
    const saved=await readJson(savedFile);
    let confirmed=[];
    if(saved) {
      if(saved.resultSha256!==hash(saved.replay))return absent('rss_replay_integrity_failed');
      for (const row of saved.replay.items) {
        const verify=async(file,sha)=>digest(await fs.readFile(file).catch(()=>Buffer.alloc(0)))===sha;
        const requestFile=row.requestFile || path.join(path.dirname(row.bodyFile),'preprocess-request.json');
        if(!await verify(row.bodyFile,row.bodySha256) || !await verify(requestFile,row.requestSha256) ||
          !await verify(row.previewFile,row.previewSha256))
          return absent('rss_replayed_artifact_changed');
      }
      if(!saved.replay.pending.some(row=>row.reason==='isolated_preview_unavailable' ||
        (saved.version!==2 && row.reason==='sealed_feed_has_no_verified_fulltext')))return saved.replay;
      confirmed=saved.replay.items;
    }
    const items=[...confirmed],pending=[],seen=new Set([...known,...confirmed.map(item=>item.key)]);
    const outputRoot=path.join(work,'imports','rss','source-v1');
    for(const source of checkpoint.sources.filter(source=>source.mode==='reports')) {
      const feed=await capture.fetchFeed(source.url).catch(()=>null);
      if(!feed){
        pending.push({sourceId:source.id,reason:'sealed_feed_failed'});continue;
      }
      const rows=(await parseFeedDocument(feed.text,feed.finalUrl)).items;
      for(const item of rows) {
        if(!item.item_url || !includesPublication(source,item.published_at))continue;
        const key=digest(materialKey(item.item_url));
        if(seen.has(key))continue;
        seen.add(key);
        if(!['fulltext_ready','summary_only'].includes(item.feed_content.status)){
          pending.push({sourceId:source.id,key,reason:'sealed_feed_has_no_verified_fulltext'});continue;
        }
        try {
          const scan=await syncFeedDocument({feedUrl:source.url,xml:feed.text,response:{final_url:feed.finalUrl,
            headers:Object.fromEntries(feed.response.headers)},outputRoot,fetchedAt:capture.fetchedAt,
            onlyItemUrls:[item.item_url],preserveFeedState:true,fetchFulltext:item.feed_content.status==='summary_only',
            articleFetcher:url=>fetchBoundArticle(url,fetchPage)});
          const record=scan.items.find(row=>row.identity.normalized_item_url===item.item_url) || scan.items[0];
          const packageDir=record?.package_path || record?.existing_package_path;
          const pkg=packageDir && await readJson(path.join(packageDir,'package.json'));
          if(pkg?.content_status==='fetch_failed'){
            pending.push({sourceId:source.id,key,reason:blockedBodyReason(record.errors||[])});
            continue;
          }
          if(pkg?.content_status!=='fulltext_ready' || pkg.hashes?.raw_feed_sha256!==digest(feed.text) ||
            digest(materialKey(pkg.identity.normalized_item_url))!==key ||
            pkg.receipt?.preprocessing_handoff!=='request_ready')throw Error('replay_package_proof_invalid');
          const bodyFile=path.join(packageDir,pkg.artifacts.source_markdown), requestFile=path.join(packageDir,pkg.artifacts.preprocess_request);
          const body=await fs.readFile(bodyFile,'utf8'), rawRequest=await fs.readFile(requestFile);
          const request=JSON.parse(rawRequest);
          const bodySha256=digest(body);
          if(bodySha256!==pkg.hashes?.source_markdown_sha256 || request.material?.markdown!==body)
            throw Error('replay_body_hash_mismatch');
          const length=meaningfulLength(body);
          if(length<LONG_THRESHOLD){
            pending.push({sourceId:source.id,key,reason:'short_report_delivery_owned_by_windows'});continue;
          }
          const entry={material_id:pkg.material_id,item_url:item.item_url,platform:'rss',eligible_for_preprocess:true,
            route:'long_review',meaningful_length:length,preprocess_request_path:requestFile,preprocess_request_sha256:digest(rawRequest),
            reading_options:{direct_reading:source.direct_reading,generate_guide:source.generate_guide,translation_mode:source.translation_mode}};
          const preview=await preparePreview(work,entry);
          if(digest(await fs.readFile(bodyFile))!==bodySha256 || digest(await fs.readFile(requestFile))!==entry.preprocess_request_sha256 ||
             digest(await fs.readFile(entry.review_preview.result_path))!==preview.previewSha256)throw Error('replay_preview_integrity_failed');
          items.push({sourceId:source.id,url:pkg.identity.normalized_item_url,key,id:entry.material_id,input:preview.input,placement:'same_cycle_daily',
            feedSha256:pkg.hashes.raw_feed_sha256,bodyMethod:pkg.receipt?.fulltext_evidence?.source_ref || item.feed_content.status,
            bodyFile,bodySha256,requestFile,requestSha256:entry.preprocess_request_sha256,
            previewFile:entry.review_preview.result_path,previewSha256:preview.previewSha256,consumerSha256:preview.consumerSha256});
        } catch(error) {
          pending.push({sourceId:source.id,key,reason:/^(?:replay_|report_replay_)[a-z_]+$/u.test(error.message)?error.message:'isolated_preview_unavailable'});
        }
      }
    }
    const replay={status:items.length?'provisional_draft':'waiting_input',captureSha256:capture.sha256,items,pending};
    await writeJson(savedFile,{version:2,replay,resultSha256:hash(replay)});
    return replay;
  },{waitMs:5000});
}
