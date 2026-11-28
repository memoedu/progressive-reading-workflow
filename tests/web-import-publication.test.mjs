import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sharedReadingOptionsKey, sharedReadingProcessingKey } from '../subscription-workflow/shared-library-client.mjs';
import { setTimeout } from 'node:timers/promises';

const html = pathname => '<html><head><meta charset="utf-8"><title>Publication ' + pathname +
  '</title></head><body><article><h1>Fixture article</h1><p>' +
  'This is a complete fixture describing publication order and how archive bytes are verified. '.repeat(25) + '</p></article></body></html>';

test('URL imports save locally, verify GitHub readback across reader routes and persist retry receipts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-import-shared-'));
  const endpoint = 'https://sync.fixture.example/progressive-reading-sync/';
  const host = 'https://www.readthesequences.com';
  const appScript = fileURLToPath(new URL('../scripts/progressive-reading-app.mjs', import.meta.url));
  await fs.mkdir(path.join(root,'.local-ir'));
  await fs.mkdir(path.join(root,'config'));
  await fs.copyFile(new URL('../config/import-destination-routes.json',import.meta.url),
    path.join(root,'config','import-destination-routes.json'));
  await fs.writeFile(path.join(root,'.local-ir','subscription-library-sync.json'),JSON.stringify({
    endpoint, session_endpoint:endpoint, token:'fixture-only'
  }));
  const hook = path.join(root,'fetch-fixture.mjs');
  const translatedOptions = {input_form:'written',content_profile:'natural_language',spoken_to_written:false,
    structure_body:false,include_reading_guide:false,translation_mode:'terminology'};
  const translatedBody = '# 样本文档｜Fixture article\n\n---\n\n## 正文\n\n这是用于导入验证的译文。\n\n---\n\n## 原文\n\nThis is the fixture original.';
  await fs.writeFile(hook,`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { createHash } from 'node:crypto';
    const root = process.env.PROGRESSIVE_READING_WORKFLOW_ROOT;
    const commit = '1'.repeat(40);
    const blobs = new Map();
    const index = new Map();
    const digest = value => createHash('sha256').update(value).digest('hex');
    const source = '${host}/translated';
    const original = 'This is the fixture original.';
    const translatedBody = ${JSON.stringify(translatedBody)};
    const originalSha256 = digest(original);
    const readingSha256 = digest(translatedBody);
    blobs.set(originalSha256+'.md',original);
    blobs.set('reading-'+readingSha256+'.md',translatedBody);
    index.set(digest(source), {schema:'progressive-reading.shared-article/v1',url:source,title:'Fixture article',
      original:{path:'原稿/'+digest(source).slice(0,24)+'/'+originalSha256+'.md',sha256:originalSha256},
      reading_files:[{original_sha256:originalSha256,sha256:readingSha256,
        path:'加工版本/'+digest(source).slice(0,24)+'/reading-'+readingSha256+'.md',
        processing_sha256:'${sharedReadingProcessingKey({processingOptions:translatedOptions})}',
        options_sha256:'${sharedReadingOptionsKey({processingOptions:translatedOptions})}'}]});
    let firstReadback = false;
    let retryRequests = 0;
    const html = ${html.toString()};
    globalThis.fetch = async (input, options) => {
      const url = new URL(input);
      if (url.origin === '${host}') {
        assert.notEqual(url.pathname, '/translated', 'A shared translation should not fetch the public site again');
        return new Response(html(url.pathname),{headers:{'Content-Type':'text/html; charset=utf-8'}});
      }
      if (url.origin === 'https://raw.githubusercontent.com') {
        const blob=blobs.get(decodeURI(url.pathname).split('/').at(-1));
        assert.ok(blob);
        if (firstReadback) {
          assert.equal((await fs.readdir(path.join(root,'阅读区'),{recursive:true})).some(name => name.endsWith('.md')),true);
          firstReadback = false;
        }
        await fs.writeFile(path.join(root,'readback-completed'),commit);
        return new Response(blob);
      }
      assert.equal(url.origin,'https://sync.fixture.example');
      if (url.pathname.endsWith('/article')) {
        const record = index.get(JSON.parse(options.body).sha256);
        return Response.json(record ? {status:'available',commit,record} : {status:'local_only',reason:'shared_source_not_found'});
      }
      assert.ok(url.pathname.endsWith('/publication'));
      const {url:source,original,reading,processing_sha256,options_sha256} = JSON.parse(options.body);
      firstReadback = source.endsWith('/verified');
      if (source.endsWith('/retry') && retryRequests++ === 0) return Response.json({error:'shared_github_unavailable'},{status:503});
      const digest = value => createHash('sha256').update(value).digest('hex');
      const hash = digest(original);
      blobs.set(hash+'.md',original);
      if (!source.endsWith('/snapshot')) assert.equal(reading,undefined);
      const readingFiles = reading === undefined ? [] : [{
        original_sha256:hash,processing_sha256,options_sha256,sha256:digest(reading),
        path:'加工版本/'+digest(source).slice(0,24)+'/reading-'+digest(reading)+'.md'
      }];
      if (readingFiles.length) blobs.set('reading-'+digest(reading)+'.md',reading);
      const record = {schema:'progressive-reading.shared-article/v1',
        url:source,title:'Fixture article',original:{path:'原稿/'+digest(source).slice(0,24)+'/'+hash+'.md',sha256:hash},
        reading_files:readingFiles};
      index.set(digest(source), record);
      await fs.appendFile(path.join(root,'publication-writes'),source+'\\n');
      return Response.json({status:'available',commit,record});
    };
  `);
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath,['--import',pathToFileURL(hook).href,appScript],{
    env:{...process.env, NODE_ENV:'development', PROGRESSIVE_READING_WORKFLOW_ROOT:root,
      PROGRESSIVE_READING_APP_PORT:String(port), PROGRESSIVE_READING_WRITE_SERVER_INFO:'false',
      PROGRESSIVE_READING_SHARED_LIBRARY_ENDPOINT:endpoint, PROGRESSIVE_READING_BROWSER_PREPROCESS_TEST_PRODUCER:''},
    stdio:['ignore','ignore','pipe'], windowsHide:true
  });
  const exited = once(child,'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    await fs.rm(root, { recursive:true, force:true });
  });
  let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  const base = 'http://127.0.0.1:'+port;
  async function poll(query, complete) {
    for (let j=0; j<360; j++) {
      const result = await fetch(base+query).then(response=>response.json()).catch(()=>null);
      if (result && complete(result)) return result;
      if (child.exitCode !== null) break;
      await setTimeout(100);
    }
    assert.fail('Import did not complete '+stderr);
  }
  await poll('/api/highlights/health', result=>result.status==='ok');
  let retryRequest;
  for (const [slug,expected,source] of [['verified','available','new_reader_import'],['retry','retry_wait','obsidian_local_ir']]) {
    const created = await fetch(base+'/api/browser-import/requests',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({
        urls:[host+'/'+slug],source,processing_mode:'original_text'
      })}).then(response=>response.json());
    assert.ok(created.request_id);
    const completed = (await poll('/api/browser-import/requests/'+created.request_id,value=>value.terminal)).results[0];
    assert.equal(completed.status,'imported');
    assert.ok(completed.receipt.shared_reading.sync_id);
    const published = await poll('/api/browser-import/requests/'+created.request_id,
      value => value.results[0]?.receipt?.shared_reading?.status === expected);
    const receipt=published.results[0].receipt.shared_reading;
    assert.equal(receipt.status,expected);
    if (slug==='verified') assert.equal(await fs.readFile(path.join(root,'readback-completed'),'utf8'),receipt.commit);
    else {
      assert.deepEqual(await fetch(base+'/api/import-center/shared-publications/'+receipt.sync_id).then(r=>r.json()),receipt);
      const retry = path.join(root,'.local-ir','shared-reading-publications',receipt.sync_id+'.json');
      const waiting = JSON.parse(await fs.readFile(retry,'utf8'));
      await fs.writeFile(retry+'.test',JSON.stringify({...waiting,retry_at:0}));
      await fs.rename(retry+'.test',retry);
      retryRequest = created.request_id;
    }
    await fs.access(completed.artifacts.find(item=>item.kind==='markdown').path);
  }
  const snapshot = await fetch(base+'/api/highlights/import-local',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({
      async:true, client_request_id:'reading-publication-snapshot',
      draft:{id:'fixture-snapshot',url:host+'/snapshot',title:'Publication /snapshot',html:html('/snapshot')},
      processing_options:{input_form:'written',content_profile:'natural_language',source_language:'en',
        translate:false,spoken_to_written:false,structure_body:false,include_reading_guide:false}
    })}).then(response=>response.json());
  assert.ok(snapshot.request_id);
  const snapshotResult = (await poll('/api/browser-import/requests/'+snapshot.request_id,value=>value.terminal)).results[0];
  assert.equal(snapshotResult.receipt?.processing_mode,'standard_preprocess',JSON.stringify(snapshotResult.errors));
  assert.ok(snapshotResult.receipt.shared_reading.sync_id);
  assert.ok(snapshotResult.receipt.shared_original.sync_id);
  const recovered = await poll('/api/browser-import/requests/'+retryRequest,
    value=>value.results[0]?.receipt?.shared_reading?.status==='available');
  assert.equal(recovered.results[0].receipt.shared_reading.commit,'1'.repeat(40));
  const originalSynced = await poll('/api/browser-import/requests/'+snapshot.request_id,
    value=>value.results[0]?.receipt?.shared_original?.status==='available' && value.results[0]?.receipt?.shared_reading?.status==='available');
  assert.ok(originalSynced.results[0].receipt.shared_reading.reading.sha256);
  assert.equal(originalSynced.results[0].receipt.shared_original.original.sha256,
    originalSynced.results[0].receipt.shared_reading.original.sha256);
  assert.equal(originalSynced.results[0].receipt.shared_original.reading,undefined);
  const writesBefore = await fs.readFile(path.join(root, 'publication-writes'), 'utf8');
  const repeated = await fetch(base+'/api/browser-import/requests', {method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({ urls:[host+'/verified'], source:'other_reader', processing_mode:'original_text' })}).then(response=>response.json());
  const replay = (await poll('/api/browser-import/requests/'+repeated.request_id,value=>value.terminal)).results[0];
  assert.equal(replay.status,'idempotent_replay');
  assert.equal(replay.receipt.shared_original.reused,true);
  assert.equal(replay.receipt.shared_original.commit,'1'.repeat(40));
  assert.equal(await fs.readFile(path.join(root, 'publication-writes'), 'utf8'), writesBefore);

  const downloaded = await fetch(base+'/api/browser-import/requests', {method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({urls:[host+'/translated'], source:'other_reader', processing_mode:'standard_preprocess',
      processing_options:translatedOptions})}).then(response=>response.json());
  const downloadedResult = (await poll('/api/browser-import/requests/'+downloaded.request_id,value=>value.terminal)).results[0];
  assert.equal(downloadedResult.status, 'idempotent_replay');
  assert.equal(downloadedResult.receipt.shared_reading.reused, true);
  const translated = downloadedResult.artifacts.find(item=>item.kind==='markdown');
  assert.match(path.basename(translated.path), /^样本文档｜Fixture article--浏览器加工--/u);
  const downloadedMarkdown = await fs.readFile(translated.path,'utf8');
  assert.match(downloadedMarkdown, /^translation_state: generated_translation$/mu);
  assert.ok(downloadedMarkdown.trimEnd().endsWith(translatedBody));
  assert.equal(await fs.readFile(path.join(root, 'publication-writes'), 'utf8'), writesBefore);
});
