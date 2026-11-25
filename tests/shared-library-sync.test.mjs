import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSharedAccount, createSharedLibraryServer } from '../subscription-workflow/shared-library-service.mjs';
import { createSharedGitHub } from '../subscription-workflow/shared-library-github.mjs';
import { createPublicRssSources } from '../subscription-workflow/shared-library-sources.mjs';
import { syncFeedDocument } from '../rss-source/core.mjs';
import { downloadSharedReading, resolveSharedSubscription, sharedLibrarySettings, syncSharedReading, updateSharedLibrarySettings } from '../subscription-workflow/shared-library-client.mjs';
import { sharedArticleUrl, sharedDigest, sharedIndexPath, sharedOriginalRevisionPath, sharedReadingPath, sharedSchema, sharedRawUrl } from '../subscription-workflow/shared-library.mjs';

const existingUrl = 'https://www.benkuhn.net/existing';
const commit = '1'.repeat(40);
const markdown = '# Public fixture\n\n' + 'An independently sourced paragraph. '.repeat(10);
const record = { schema: sharedSchema, title: 'Public fixture', url: existingUrl,
  original: { path: 'Test folder/Original.md', sha256: sharedDigest(markdown) } };

test('a verified publication separates original and reading files and reuses only matching processing settings', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'public-reading-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const url = 'https://mp.weixin.qq.com/s/fixture-public-article';
  const title = 'Fixture public article';
  const reading = markdown + '\n\n## 阅读前置卡\n\nA guide with source links.';
  let indexed, verificationCalls = 0;
  const blobs = new Map();
  const password = 'fixture-account-only';
  const server = createSharedLibraryServer({
    config: { accounts: { owner: await createSharedAccount(password) }, gitleaks: 'fixture' },
    verifyReadingSource: async source => { verificationCalls++; return source === url ? { title, markdown } : null; },
    scan: async () => true,
    github: {
      ready: true, lookup: async () => ({ commit, record: indexed }), lookupArticleHash: async () => ({ commit, record: indexed }),
      publishReading: async ({ url: source, original, reading: body, processingSha256 }) => {
        const sha = sharedDigest(original);
        const originalEntry = { path: sharedOriginalRevisionPath(source, sha), sha256: sha };
        blobs.set(originalEntry.path, original);
        indexed ??= { schema: sharedSchema, url: source, title, original: originalEntry };
        if (body) {
          const version = { path: sharedReadingPath(source, sharedDigest(body)), sha256: sharedDigest(body),
            original_sha256: sha, processing_sha256: processingSha256 };
          blobs.set(version.path, body);
          indexed.reading_files = [version];
        }
        return { status: 'available', commit, record: indexed };
      }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = 'https://library.example/progressive-reading-sync/';
  let corrupt = false;
  const fetchImpl = async (target, options) => {
    const request = String(target);
    if (request.startsWith(endpoint)) return fetch(request.replace('https://library.example', `http://127.0.0.1:${server.address().port}`), options);
    for (const [file, body] of blobs) if (request === sharedRawUrl(commit, file)) return new Response(corrupt ? body + '!' : body);
    return new Response(null, { status: 404 });
  };
  await updateSharedLibrarySettings(root, { enabled: true });
  const config = path.join(root, '.local-ir', 'subscription-library-sync.json');
  await fs.writeFile(config, JSON.stringify({ endpoint }));
  await updateSharedLibrarySettings(root, { action: 'login', account: 'owner', password }, fetchImpl);

  assert.equal((await syncSharedReading(root, { url, original: markdown }, { fetchImpl })).status, 'available');
  const supplied = { url, original: markdown, markdown: '---\nbrowser_draft_id: private-state\n---\n\n' + reading,
    processingOptions: { translate: true, include_reading_guide: true } };
  const receipt = await syncSharedReading(root, supplied, { fetchImpl });
  assert.equal(receipt.status, 'available');
  assert.notEqual(receipt.original.path, receipt.reading.path);
  assert.equal(blobs.get(receipt.reading.path), reading);
  assert.equal(verificationCalls, 1);
  await updateSharedLibrarySettings(root, { action: 'logout' });
  const same = await downloadSharedReading(root, { url, processingOptions: { include_reading_guide: true, translate: true } }, { fetchImpl });
  assert.equal(same.readingBytes.toString(), reading);
  assert.equal(same.originalBytes.toString(), markdown);
  assert.equal(await downloadSharedReading(root, { url, processingOptions: { include_reading_guide: false, translate: true } }, { fetchImpl }), null);
  corrupt = true;
  await assert.rejects(downloadSharedReading(root, supplied, { fetchImpl }), /shared_download_hash_mismatch/u);
});

test('public-source acquisition checks feed membership and ignores credential-bearing URLs', async () => {
  const feed = 'https://news.example.com/feed.xml';
  const item = 'https://news.example.com/p/example';
  const requests = [];
  const fetchArticle = createPublicRssSources([{ feed, folder: 'Example', article_origins: ['https://news.example.com'] }], {
    fetchImpl: async url => {
      requests.push(url);
      if (url === feed) return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><link>https://news.example.com/</link><item><title>Example article</title><link>${item}</link><description>Excerpt</description></item></channel></rss>`);
      if (url === item) return new Response(`<html><head><title>Example article</title></head><body><article><h1>Example article</h1><p>${markdown.repeat(3)}</p></article></body></html>`, { headers: { 'content-type': 'text/html' } });
      throw Error('Unexpected upstream call');
    }
  });
  assert.equal(sharedArticleUrl(item + '?access_token=fixture'), null);
  assert.equal(sharedArticleUrl('http://127.0.0.1/path'), null);
  assert.equal((await fetchArticle('https://news.example.com/p/unlisted')).status, 'local_only');
  assert.deepEqual(requests, [feed]);
  assert.equal((await fetchArticle(item)).folder, 'Example');
  assert.deepEqual(requests, [feed, item]);
});

test('the cloud index uses GitHub Contents at the selected commit and distinguishes missing from corrupt entries', async () => {
  const base = 'https://api.github.com/repos/memoedu/progressive-reading-library';
  const index = url => base + '/contents/' + sharedIndexPath(url) + '?ref=' + commit;
  const missing = 'https://www.benkuhn.net/missing';
  const corrupt = 'https://www.benkuhn.net/corrupt';
  const file = data => Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(data).toString('base64') });
  const github = createSharedGitHub({ fetchImpl: async url => {
    if (url === base + '/git/ref/heads/main') return Response.json({ object: { sha: commit } });
    if (url === index(existingUrl)) return file(JSON.stringify(record));
    if (url === index(missing)) return new Response(null, { status: 404 });
    if (url === index(corrupt)) return file('truncated JSON');
    throw new Error('Unexpected GitHub request');
  } });
  assert.deepEqual(await github.lookup(existingUrl), { commit, record });
  assert.deepEqual(await github.lookupArticleHash(sharedDigest(existingUrl)), { commit, record });
  assert.deepEqual(await github.lookup(missing), { commit, record: null });
  await assert.rejects(github.lookup(corrupt), /shared_library_invalid_index/);
});

test('report intake waits for shared review and uses the GitHub body before local extraction', async t => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-report-'));
  t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  const feedUrl = 'https://www.benkuhn.net/index.xml';
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><link>${feedUrl}</link><item><title>Public fixture</title><link>${existingUrl}</link><description>Excerpt</description></item></channel></rss>`;
  let localFetches = 0;
  const options = { feedUrl, xml, outputRoot, fetchFulltext: true, articleFetcher: () => { localFetches++; } };
  const pending = await syncFeedDocument({ ...options, runId: 'pending', sharedArticleFetcher: async () => ({ status: 'pending_review' }) });
  assert.equal(pending.items[0].content_status, 'fetch_failed');
  const result = await syncFeedDocument({ ...options, runId: 'published', sharedArticleFetcher: async (_url, prior) => {
    assert.equal(prior.status, 'pending_review');
    return { status: 'available', commit, sha256: record.original.sha256, article: { markdown } };
  } });
  assert.equal(result.items[0].content_status, 'fulltext_ready');
  assert.equal(localFetches, 0);
});

test('anonymous reads, anonymous review and signed-in writes share the same service', async t => {
  const writes = [];
  const versions = [];
  const materials = [];
  const pdf = Buffer.from('%PDF-1.4 fixture for publication policy');
  const pdfHash = sharedDigest(pdf);
  let sourceFetches = 0;
  const published = new Map([[existingUrl, record]]);
  const submissions = new Map();
  const password = 'fixture-password-only';
  const server = createSharedLibraryServer({
    config: { accounts: { pilot: await createSharedAccount(password) }, gitleaks: 'fixture',
      public_materials: [{ url: 'https://example.com/original.pdf', sha256: pdfHash, extension: 'pdf', bytes: pdf.length }] },
    github: {
      ready: true, lookup: async url => ({ commit, record: published.get(url) }),
      submission: async id => submissions.get(id),
      lookupMaterial: async () => ({ commit, record: null }),
      publishVersion: async value => { versions.push(value); return { status: 'available', commit }; },
      publishMaterial: async value => { materials.push(value); return { status: 'pending_review' }; },
      publish: async value => {
        writes.push(value);
        if (value.direct) {
          published.set(value.url, value.record);
          return { status: 'available', commit, record: value.record };
        }
        const result = { status: 'pending_review', pull_request: 'https://github.com/memoedu/progressive-reading-library/pull/4' };
        submissions.set(value.submission, result);
        return result;
      }
    },
    fetchArticle: async url => {
      sourceFetches++;
      return { title: 'Fixture', markdown: url.endsWith('/blocked') ? markdown + '\nC:\\Users\\local\\private.txt' : markdown };
    },
    scan: async () => true,
    fetchMaterial: async () => new Response(pdf)
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/progressive-reading-sync/';
  async function post(route, body, token) {
    const response = await fetch(endpoint + route, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body) });
    return { code: response.status, body: await response.json() };
  }
  assert.deepEqual((await post('resolve', { url: existingUrl })).body.record, record);
  assert.deepEqual((await post('resolve', { url: existingUrl }, 'invalid')).body.record, record);
  assert.equal(sourceFetches, 0);
  const guest = { url: 'https://www.benkuhn.net/guest' };
  const [first, concurrent] = await Promise.all([post('resolve', guest), post('resolve', guest)]);
  assert.equal(first.code, 202);
  assert.deepEqual(concurrent, first);
  assert.deepEqual(await post('resolve', guest), first);
  assert.equal(sourceFetches, 1);
  assert.equal(writes[0].direct, false);
  const login = await post('session', { account: 'pilot', password });
  assert.equal(login.code, 200);
  const member = await post('resolve', { url: 'https://www.benkuhn.net/member' }, login.body.token);
  assert.equal(member.code, 200);
  assert.equal(writes[1].direct, true);
  assert.equal((await post('resolve', { url: 'https://www.benkuhn.net/blocked' }, login.body.token)).code, 422);
  assert.equal((await post('resolve', { url: 'https://www.benkuhn.net/expired' }, 'invalid')).code, 401);
  const version = { url: existingUrl, original_sha256: record.original.sha256, markdown, kind: 'translation' };
  assert.equal((await post('variant', version)).code, 401);
  assert.equal((await post('variant', { ...version, markdown: markdown + '\nC:\\Users\\local\\private.txt' }, login.body.token)).code, 422);
  assert.equal((await post('variant', version, login.body.token)).code, 200);
  assert.equal(versions.length, 1);
  assert.equal((await post('material', { sha256: 'a'.repeat(64) })).body.status, 'local_only');
  assert.equal((await post('material', { sha256: pdfHash })).code, 202);
  assert.deepEqual(materials[0].bytes, pdf);
  assert.equal(materials[0].direct, false);
  assert.equal(writes.length, 2);
});

test('local sync defaults to enabled and only accepts byte-verified pinned downloads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-subscription-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previousEndpoint = process.env.PROGRESSIVE_READING_SHARED_LIBRARY_ENDPOINT;
  delete process.env.PROGRESSIVE_READING_SHARED_LIBRARY_ENDPOINT;
  t.after(() => {
    if (previousEndpoint === undefined) delete process.env.PROGRESSIVE_READING_SHARED_LIBRARY_ENDPOINT;
    else process.env.PROGRESSIVE_READING_SHARED_LIBRARY_ENDPOINT = previousEndpoint;
  });
  assert.deepEqual(await sharedLibrarySettings(root), { enabled: true, configured: true, signed_in: false });
  const customUrl = 'https://another.example.org/article';
  await resolveSharedSubscription(root, customUrl, null, {
    fetchImpl: async (input, options) => {
      assert.equal(String(input), 'https://124.221.144.155/progressive-reading-sync/article');
      assert.equal(options.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(options.body), { sha256: sharedDigest(customUrl) });
      return Response.json({ status: 'local_only' });
    }
  });
  const local = path.join(root, '.local-ir');
  await fs.mkdir(local);
  await fs.writeFile(path.join(local, 'subscription-library-sync.json'),
    JSON.stringify({ endpoint: 'https://sync.example.test/progressive-reading-sync/' }));
  assert.deepEqual(await sharedLibrarySettings(root), { enabled: true, configured: true, signed_in: false });
  const requests = [];
  const fetchImpl = async input => {
    requests.push(String(input));
    return requests.length === 1 ? Response.json({ status: 'available', commit, record }) : new Response(markdown);
  };
  assert.equal((await resolveSharedSubscription(root, existingUrl, null, { fetchImpl })).article.markdown, markdown);
  assert.deepEqual(requests, ['https://sync.example.test/progressive-reading-sync/resolve',
    sharedRawUrl(commit, record.original.path)]);
  await updateSharedLibrarySettings(root, { enabled: false });
  assert.equal(await resolveSharedSubscription(root, existingUrl, null, { fetchImpl }), null);
  assert.equal(requests.length, 2);
});
