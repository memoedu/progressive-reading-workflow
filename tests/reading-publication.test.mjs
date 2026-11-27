import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { synchronizeReadingPublication } from '../subscription-workflow/reading-publication.mjs';
import { readingPublicationReceipt, retryReadingPublications } from '../subscription-workflow/reading-publication-outbox.mjs';
import { sharedDigest } from '../subscription-workflow/shared-library.mjs';
import { sharedReadingOptionsKey } from '../subscription-workflow/shared-library-client.mjs';
import { reconcileReadingPublication } from '../subscription-workflow/reading-publication-replay.mjs';

const root = 'fixture-only';
const url = 'https://www.readthesequences.com/fixture';
const original = 'The independently captured source for the publication test.';
const markdown = 'The validated reading edition for the publication test.';
const settings = async () => ({ enabled: true, signed_in: true });

test('publication depends on source evidence and verified output, independently of route', async () => {
  const calls = [];
  const dependencies = {
    settings,
    lookupArtifacts: async () => null,
    verifySource: async () => ({ markdown: original }),
    syncReading: async (_root, request) => {
      calls.push(request);
      return { status: 'available' };
    }
  };
  const input = { url, original, markdown, qualityStatus: 'ready', processingOptions: { translate: true } };
  for (const entry of ['known-reader', 'unregistered-reader', undefined]) {
    assert.equal((await synchronizeReadingPublication(root, { ...input, entry }, dependencies)).shared_reading.status, 'available');
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
  const input = { url, original, publicCapture:true, defer:true };
  const queued = (await synchronizeReadingPublication(temp, input, { settings, lookupArtifacts: async () => null })).shared_reading;
  assert.equal(queued.status, 'queued');
  const recovered = await retryReadingPublications(temp, { settings, syncReading:async (_root, request) => {
    assert.equal(request.original, original);
    assert.equal(request.markdown, undefined);
    return { status:'available' };
  } });
  assert.equal(recovered.status, 'available');
  assert.equal(recovered.sync_id, queued.sync_id);
});

test('mismatching public bytes and unverified archive claims never reach publication', async () => {
  const dependencies = { settings, lookupArtifacts: async () => null, verifySource: async () => ({ markdown: original }),
    lookupOriginal: async () => ({ status: 'available', sha256: sharedDigest(original) }),
    syncReading: async () => assert.fail('Unverified content must stay local') };
  const input = { url, original:'private draft bytes', markdown, qualityStatus:'ready' };
  assert.equal((await synchronizeReadingPublication(root, input, dependencies)).shared_reading.reason, 'public_source_body_mismatch');
  const forged = { ...input, url:'https://unknown.example/fixture', archiveHintSha256:sharedDigest(input.original) };
  assert.equal((await synchronizeReadingPublication(root, forged, dependencies)).shared_reading.reason, 'source_not_publicly_verified');
});

test('a temporary failure persists one retry and exposes the verified terminal receipt', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reading-publication-'));
  t.after(() => fs.rm(temp, { recursive:true, force:true }));
  const now = Date.now();
  const input = { url, original, markdown, qualityStatus:'ready', publicCapture:true };
  const failing = { settings, lookupArtifacts: async () => null, syncReading:async () => ({ status:'retry_wait', error:'shared_github_unavailable' }) };
  const first = (await synchronizeReadingPublication(temp, input, failing)).shared_reading;
  const replay = (await synchronizeReadingPublication(temp, {...input,entry:'another-caller'}, failing)).shared_reading;
  assert.equal(first.status, 'retry_wait');
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

test('checks the GitHub index before source verification and reuses both matching files', async () => {
  const entry = { sha256:sharedDigest(markdown), options_sha256:sharedReadingOptionsKey() };
  const result = await synchronizeReadingPublication(root, { url, original, markdown }, {
    settings,
    lookupArtifacts: async (_root, request) => {
      assert.equal(request.url, url);
      assert.equal(request.originalSha256, sharedDigest(original));
      assert.equal(request.includeReading, true);
      return { commit:'f'.repeat(40), original:{ sha256:sharedDigest(original) }, reading:entry };
    },
    verifySource: async () => assert.fail('verified GitHub content reuses the source'),
    syncReading: async () => assert.fail('matching reading options reuse the published edition')
  });
  assert.equal(result.shared_reading.reused, true);
  assert.deepEqual(result.shared_reading.reading, entry);
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
  await fs.appendFile(file, '\nReader’s notes.');
  calls.length = 0;
  await reconcileReadingPublication(temp, arguments_, deps);
  assert.deepEqual(calls, []);
});
