import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {digest,readJson,writeJson} from '../subscription-workflow/config.mjs';
import {captureFeeds} from '../subscription-workflow/remote-feed-stage.mjs';
import {replayReportRss} from '../subscription-workflow/report-rss-replay.mjs';
import {materialKey} from '../subscription-workflow/catalog.mjs';

const cycle='scheduled-'+new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',dateStyle:'short'}).format(new Date());
const feed={kind:'rss',enabled:true,id:'rss-ready',url:'https://example.com/feed.xml',mode:'reports',history_mode:'all',earliest_date:null};
const lost={...feed,id:'rss-missing',url:'https://other.example.com/feed.xml'};
const content='确有证据的完整文章内容。'.repeat(180);
const item=(slug,body)=>`<item><title>${slug}</title><guid>${slug}</guid><link>https://example.com/${slug}</link>${body}</item>`;
const encoded=`<content:encoded><![CDATA[<p>${content}</p>]]></content:encoded>`;
const xml=`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>Source</title><link>https://example.com/</link>
${item('known',encoded)}${item('new',encoded)}${item('teaser','<description>只有摘要</description>')}</channel></rss>`;
const plan={cycle,revision:4,coverage:[{kind:'rss',jobId:null,sha256:null}],
  rssCheckpoint:{sources:[feed,lost],knownKeys:[digest(materialKey('https://example.com/known'))]}};

test('replay uses same-cycle verified XML and body identity, skips known items and continues past missing sources',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'report-rss-replay-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'report'), capture=path.join(root,'SubscriptionFeedCapture');
  const run=()=>replayReportRss(home,plan,{preparePreview:preview});
  let calls=0;
  async function preview(_work,entry){
    calls++;
    const evidence=await fs.readFile(entry.preprocess_request_path);
    assert.equal(digest(evidence),entry.preprocess_request_sha256);
    assert.match(entry.item_url,/\/new$/u);
    const file=entry.preprocess_request_path+'.preview';
    await fs.writeFile(file,'verified preview');
    entry.review_preview={result_path:file};
    return {input:{id:entry.material_id,direct:false,length:entry.meaningful_length,preview:{status:'ready',core:'测试'}},
      previewSha256:digest('verified preview'),consumerSha256:digest(evidence)};
  }
  assert.equal((await run()).reason,'rss_capture_missing');
  await captureFeeds(capture,cycle,{enabled:true,revision:4,subscriptions:[feed,lost]},{fetchFeed:async url=>{
    if(url===lost.url)throw Error('unavailable');
    return {text:xml,finalUrl:url,response:new Response(null)};
  }});
  const first=await run();
  assert.equal(first.status,'provisional_draft');
  assert.equal(first.items.length,1);
  assert.equal(first.items[0].key,digest(materialKey('https://example.com/new')));
  assert.deepEqual(first.pending.map(entry=>entry.reason),['sealed_feed_has_no_verified_fulltext','sealed_feed_failed']);
  assert.deepEqual(await run(),first);
  assert.equal(calls,1);
  assert.equal((await replayReportRss(home,{...plan,revision:5},{preparePreview:preview})).reason,'rss_capture_incomplete_or_wrong_revision');
  await fs.appendFile(first.items[0].bodyFile,'edit');
  assert.equal((await run()).reason,'rss_replayed_artifact_changed');
  const file=path.join(capture,cycle,'capture.json');
  const seal=await readJson(file);
  seal.feeds.find(entry=>entry.status==='completed').xml+='tamper';
  await writeJson(file,seal);
  assert.equal((await run()).reason,'rss_capture_integrity_failed');
});
