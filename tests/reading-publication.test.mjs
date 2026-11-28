import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { synchronizeReadingPublication } from '../subscription-workflow/reading-publication.mjs';
import { readingPublicationReceipt, retryReadingPublications } from '../subscription-workflow/reading-publication-outbox.mjs';
import { sharedDigest } from '../subscription-workflow/shared-library.mjs';
import { reconcileReadingPublication } from '../subscription-workflow/reading-publication-replay.mjs';

const root = 'fixture-only';
const url = 'https://www.readthesequences.com/fixture';
const original = 'The independently captured source for the publication test.';
const markdown = 'The validated reading edition for the publication test.';
const settings = async () => ({ enabled: true, signed_in: true });

test('independent generated artifacts enqueue without calling the capture or processing service', async () => {
  const calls = [];
  const dependencies = {
    queueRetry: async (_root, request, receipt) => {
      calls.push(request);
      return receipt;
    }
  };
  const input = { url, original, markdown, qualityStatus: 'ready', processingOptions: { translate: true } };
  for (const entry of ['known-reader', 'unregistered-reader', undefined]) {
    assert.equal((await synchronizeReadingPublication(root, { ...input, entry }, dependencies)).shared_reading.status, 'queued');
  }
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[1], calls[2]);
  await synchronizeReadingPublication(root, { ...input, qualityStatus: 'warning' }, dependencies);
  assert.equal(calls[3].markdown, markdown);
  assert.equal(calls[3].original, original);
  const reused = await synchronizeReadingPublication(root, { reused: { commit: 'f'.repeat(40), original:{sha256:'a'.repeat(64)} } }, dependencies);
  assert.equal(reused.shared_reading.reused, true);
  assert.equal(calls.length, 4);
});

test('the original can queue before processing has produced a reading edition', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reading-original-'));
  t.after(() => fs.rm(temp, { recursive:true, force:true }));
  const input = { url, original };
  const queued = (await synchronizeReadingPublication(temp, input)).shared_reading;
  assert.equal(queued.status, 'queued');
  const recovered = await retryReadingPublications(temp, { settings, syncReading:async (_root, request) => {
    assert.equal(request.original, original);
    assert.equal(request.markdown, undefined);
    return { status:'available' };
  } });
  assert.equal(recovered.status, 'available');
  assert.equal(recovered.sync_id, queued.sync_id);
});

test('a temporary failure persists one retry and exposes the verified terminal receipt', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reading-publication-'));
  t.after(() => fs.rm(temp, { recursive:true, force:true }));
  const now = Date.now();
  const input = { url, original, markdown };
  const queued = (await synchronizeReadingPublication(temp, input)).shared_reading;
  const first = await retryReadingPublications(temp, { settings, now:now+100,
    syncReading:async () => ({ status:'retry_wait', error:'shared_github_unavailable' }) });
  const replay = (await synchronizeReadingPublication(temp, {...input,entry:'another-caller'})).shared_reading;
  assert.equal(first.status, 'retry_wait');
  assert.equal(first.sync_id, queued.sync_id);
  assert.match(first.sync_id, /^[a-f0-9]{64}$/u);
  assert.deepEqual(first,replay);
  assert.deepEqual(await readingPublicationReceipt(temp, first.sync_id), first);
  assert.equal(await retryReadingPublications(temp,{settings, now}), null);
  let sent = 0;
  const recovered = { status:'available', commit:'a'.repeat(40) };
  const options = { now:now+120_000, settings, syncReading: async (_root, value) => {
    sent++;
    assert.equal(value.original,original);
    assert.equal(value.markdown,markdown);
    return recovered;
  } };
  assert.equal(await retryReadingPublications(temp,{...options, settings:async () => ({enabled:false,signed_in:true})}), null);
  assert.deepEqual(await retryReadingPublications(temp,options), {...recovered,sync_id:first.sync_id});
  assert.deepEqual(await readingPublicationReceipt(temp, first.sync_id), {...recovered,sync_id:first.sync_id});
  assert.equal(await retryReadingPublications(temp,options), null);
  assert.equal(sent,1);
});

test('a legacy size rejection can replay the identical Markdown under the expanded limit', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reading-publication-size-replay-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const input = { url, original: original.repeat(13_000) };
  const { shared_reading: first } = await synchronizeReadingPublication(temp, input);
  const eventId = first.sync_id;
  await retryReadingPublications(temp, { eventId, settings,
    syncReading: async () => ({ status: 'local_only', reason: 'shared_invalid_reading' }) });
  const { shared_reading: replay } = await synchronizeReadingPublication(temp, input);
  assert.deepEqual(replay, { status: 'queued', sync_id: eventId });
  const receipt = await retryReadingPublications(temp, { eventId, settings, syncReading: async (_root, request) => {
    assert.equal(sharedDigest(request.original), sharedDigest(input.original));
    return { status: 'available' };
  } });
  assert.deepEqual(receipt, { status: 'available', sync_id: eventId });
  assert.deepEqual((await synchronizeReadingPublication(temp, input)).shared_reading, receipt);
});

test('a locally reused article synchronizes only the provable missing artifacts', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reading-publication-replay-'));
  t.after(() => fs.rm(temp, { recursive:true, force:true }));
  const file = path.join(temp, 'reading.md');
  const sidecar = path.join(temp, 'sidecar.json');
  await fs.writeFile(file, markdown);
  await fs.writeFile(sidecar, JSON.stringify({ content:{ markdownSha256:sharedDigest(markdown) }, annotations:[] }));
  await fs.writeFile(path.join(temp, 'request.json'), JSON.stringify({ material:{ markdown:original }, source_metadata:{ source_url:url } }));
  const retained = { receipt:{ raw_markdown_sha256:sharedDigest(original) }, artifacts:[
    { kind:'markdown', path:file, sha256:sharedDigest(markdown) }, { kind:'browser_ir_metadata', path:sidecar },
    { kind:'standard_preprocess_audit', path:temp }
  ] };
  const calls = [];
  const deps = { synchronize:async (_root, value) => { calls.push(value); return { shared_reading:{ status:'available' } }; } };
  const arguments_ = { url, file, retained, indexed:{ commit:'b'.repeat(40), original:{ sha256:sharedDigest(original) } } };
  const result = await reconcileReadingPublication(temp, arguments_, deps);
  assert.equal(result.shared_original.reused, true);
  assert.deepEqual(calls.map(call => call.markdown), [markdown]);
  calls.length = 0;
  arguments_.indexed.reading = { sha256:sharedDigest('a previous rendering of the same options') };
  await reconcileReadingPublication(temp, arguments_, deps);
  assert.deepEqual(calls.map(call => call.markdown), [markdown]);
  arguments_.indexed.reading = { sha256:sharedDigest(markdown.trim()) };
  calls.length = 0;
  assert.equal((await reconcileReadingPublication(temp, arguments_, deps)).shared_reading.reused, true);
  assert.deepEqual(calls, []);
  await fs.appendFile(file, '\nReader’s notes.');
  calls.length = 0;
  await reconcileReadingPublication(temp, arguments_, deps);
  assert.deepEqual(calls, []);
});
