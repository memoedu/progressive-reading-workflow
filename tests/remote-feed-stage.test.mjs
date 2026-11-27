import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { digest, readJson } from '../subscription-workflow/config.mjs';
import { acknowledgeCapture, captureFeeds, readCapturedFeeds } from '../subscription-workflow/remote-feed-stage.mjs';

const config = { enabled: true, revision: 3, subscriptions: [
  { id: 'fixture', url: 'https://example.org/rss', enabled: true, kind: 'rss' },
  { id: 'not-a-feed', url: 'https://example.org/column', enabled: true, kind: 'zhihu_column' }
] };
const cycle = 'scheduled-2026-11-28';
const xml = '<rss version="2.0"><channel><title>Fixture</title><link>https://example.org/</link><description>Fixture feed</description><item><title>Story</title><link>https://example.org/story</link><description>Body</description></item></channel></rss>';

test('frozen RSS capture replays without fetching and recognizes the original Windows job', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rss-stage-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let calls = 0;
  const options = { fetchFeed: async url => {
    calls++;
    return { text: xml, finalUrl: url, response: new Response(null, { headers: { etag: '"fixture"' } }) };
  } };
  const first = await captureFeeds(home, cycle, config, options);
  assert.equal(first.status, 'completed');
  assert.equal(first.feeds, 1);
  assert.equal(first.items, 1);
  assert.deepEqual(await captureFeeds(home, cycle, config, options), first);
  assert.equal(calls, 1);
  await assert.rejects(captureFeeds(home, cycle, { ...config, revision: 4 }, options), /cycle_input_conflict/);
  const file = path.join(home, cycle, 'capture.json');
  const captured = await readCapturedFeeds(file, cycle, config);
  assert.equal((await captured.fetchFeed(config.subscriptions[0].url)).text, xml);
  await assert.rejects(captured.fetchFeed('https://example.org/not-staged'), /source_missing/);
  const ack = { sha256: captured.sha256, jobId: digest('rss:' + cycle).slice(0, 32) };
  const recovered = await acknowledgeCapture(home, cycle, ack);
  assert.deepEqual(await acknowledgeCapture(home, cycle, ack), recovered);
  await assert.rejects(acknowledgeCapture(home, cycle, { ...ack, sha256: 'other' }), /ack_mismatch/);
  const tampered = await readJson(file);
  tampered.feeds[0].xml += 'mutated';
  await fs.writeFile(file, JSON.stringify(tampered));
  await assert.rejects(readCapturedFeeds(file, cycle, config), /identity_or_hash_mismatch/);
});
