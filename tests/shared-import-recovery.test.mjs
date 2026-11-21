import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
import {startFixture} from '../scripts/browser-import-web/fixture.mjs';
import {digest, writeJson} from '../subscription-workflow/config.mjs';
import {runPath} from '../site-import/store.mjs';

test('browser and Obsidian reuse verified site captures and retain failed attempts', async () => {
  const fixture = await startFixture();
  const get = async route => {
    const response = await fetch(fixture.baseUrl + route);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = async (route, body, status = 202) => {
    const response = await fetch(fixture.baseUrl + route, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
    assert.equal(response.status, status);
    return response.json();
  };
  const terminal = async id => {
    for (let i=0;i<150;i++) {
      const value = await get('/api/browser-import/requests/' + id);
      if (value.terminal) return value;
      await wait(100);
    }
    assert.fail('import request did not finish: ' + id);
  };

  try {
    const directory = runPath(fixture.workflowRoot, 'site-run-0123456789abcdef01234567');
    const entries = [
      {source:'browser_extension', url:fixture.sourceUrl + '/js', title:'共享采集合成材料甲'},
      {source:'obsidian_local_ir', url:fixture.sourceUrl + '/auth', title:'共享采集合成材料乙'}
    ];
    const markdown = Array.from({length:6}, ()=>'这是已校验的整站正文。浏览器和 Obsidian 都应导入同一份正文并保留来源。').join('\n\n');
    for (const {url,title} of entries) {
      await writeJson(path.join(directory, 'sources', digest(url)+'.json'), {url, title, markdown, metadata:{},
        source_response:{url, sha256:digest(markdown)}});
    }
    await writeJson(path.join(directory, 'inventory.json'), {
      complete:true, articles:entries.map(({url})=>({url, markdown_sha256:digest(markdown)}))
    });
    for (const {source,url} of entries) {
      const created = await post('/api/browser-import/requests', {urls:[url], source, processing_mode:'original_text'});
      const {results:[result]} = await terminal(created.request_id);
      assert.equal(result.status, 'imported');
      assert.equal(result.receipt.source_reused, 'verified_site_capture');
      assert.equal(result.receipt.processing_mode, 'original_text');
      const artifact = result.artifacts.find(item=>item.kind==='markdown');
      const body = await fs.readFile(artifact.path,'utf8');
      assert.match(body,/已校验的整站正文/u);
    }
    assert.deepEqual(fixture.hits, []);

    const since = encodeURIComponent(new Date(Date.now()-1000).toISOString());
    const failure = await post('/api/browser-import/requests', {
      urls:[fixture.sourceUrl + '/flaky'], source:'obsidian_local_ir', processing_mode:'original_text'
    });
    const original = await terminal(failure.request_id);
    assert.equal(original.status, 'failed');
    const taskId = original.results[0].task_id;
    const feed = '/api/import-center/maintenance-failures?since=' + since;
    const {failures:[incident]} = await get(feed);
    assert.equal(incident.task_id, taskId);
    assert.equal(incident.stage, 'source_fetch');
    assert.doesNotMatch(JSON.stringify(incident), /flaky|127\.0\.0\.1/u);
    fixture.recover();
    const route = '/api/import-center/maintenance-retry';
    const retry = await post(route, {task_id:taskId});
    assert.equal((await post(route, {task_id:taskId})).request_id, retry.request_id);
    assert.equal((await terminal(retry.request_id)).imported, 1);
    assert.equal((await terminal(failure.request_id)).status, 'failed');
    assert.deepEqual((await get(feed)).failures[0].retry, {request_id:retry.request_id,status:'imported',verified:true});
    const sources = new Set((await get('/api/import-center/history')).requests.map(item=>item.source));
    assert.ok(sources.has('browser_extension') && sources.has('obsidian_local_ir'));
  } finally {
    await fixture.stop();
  }
});
