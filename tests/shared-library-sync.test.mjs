import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSharedAccount, createSharedLibraryServer } from '../subscription-workflow/shared-library-service.mjs';
import { createSharedGitHub } from '../subscription-workflow/shared-library-github.mjs';
import { resolveSharedSubscription, sharedLibrarySettings, updateSharedLibrarySettings } from '../subscription-workflow/shared-library-client.mjs';
import { sharedDigest, sharedIndexPath, sharedSchema, sharedRawUrl } from '../subscription-workflow/shared-library.mjs';

const existingUrl = 'https://www.benkuhn.net/existing';
const commit = '1'.repeat(40);
const markdown = '# Public fixture\n\n' + 'An independently sourced paragraph. '.repeat(10);
const record = { schema: sharedSchema, title: 'Public fixture', url: existingUrl,
  original: { path: 'Test folder/Original.md', sha256: sharedDigest(markdown) } };

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
  assert.deepEqual(await github.lookup(missing), { commit, record: null });
  await assert.rejects(github.lookup(corrupt), /shared_library_invalid_index/);
});

test('anonymous reads, anonymous review and signed-in writes share the same service', async t => {
  const writes = [];
  let sourceFetches = 0;
  const published = new Map([[existingUrl, record]]);
  const submissions = new Map();
  const password = 'fixture-password-only';
  const server = createSharedLibraryServer({
    config: { accounts: { pilot: await createSharedAccount(password) }, gitleaks: 'fixture' },
    github: {
      ready: true, lookup: async url => ({ commit, record: published.get(url) }),
      submission: async id => submissions.get(id),
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
    scan: async () => true
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
  assert.equal(writes.length, 2);
});

test('local sync defaults to enabled and only accepts byte-verified pinned downloads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-subscription-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
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
