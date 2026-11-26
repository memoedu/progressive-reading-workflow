import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createOriginalMarkdownBackup, publicArchiveContainsPrivateData } from '../scripts/original-markdown-backup.mjs';

const blob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');

async function fixture(t, run, config = {}, mayWrite) {
  const workflowRoot = await fs.mkdtemp(path.join(process.env.PROGRESSIVE_READING_TEST_TEMP || os.tmpdir(), 'original-markdown-'));
  t.after(() => fs.rm(workflowRoot, { recursive: true, force: true }));
  const readingRoot = path.join(workflowRoot, '阅读区');
  await fs.mkdir(path.join(workflowRoot, '.local-ir'));
  await fs.writeFile(path.join(workflowRoot, '.local-ir/original-markdown-backup.json'),
    JSON.stringify({ repository: 'example/private-archive', origins: ['https://example.org'], ...config }));
  return {
    backup: createOriginalMarkdownBackup({ workflowRoot, readingRoot, run, mayWrite }),
    file: path.join(readingRoot, '分组', '原始.md'),
    url: 'https://example.org/article',
    markdown: '# 原标题\r\n\r\n原始的 Markdown。 \r\n',
    authenticated: false
  };
}

test('archives exact anonymous Markdown once and preserves an existing different blob', async t => {
  const remote = new Map();
  let writes = 0;
  const { backup, ...source } = await fixture(t, async (program, args, input) => {
    if (program === 'gitleaks') return { code: 0 };
    if (args.includes('repos/example/private-archive')) return { code: 0, stdout: 'true\tfalse\tmain' };
    const endpoint = args.find(arg => arg.includes('/contents/')).split('?')[0];
    if (!args.includes('PUT')) return remote.has(endpoint) ? { code: 0, stdout: remote.get(endpoint) } : { code: 1, missing: true };
    const body = JSON.parse(input);
    assert.equal(body.branch, 'main');
    assert.equal('sha' in body, false);
    assert.match(body.author.email, /@users\.noreply\.github\.com$/u);
    assert.deepEqual(body.committer, body.author);
    const raw = Buffer.from(body.content, 'base64');
    assert.deepEqual(raw, Buffer.from(source.markdown));
    remote.set(endpoint, blob(raw));
    writes++;
    return { code: 0, stdout: blob(raw) };
  });
  const first = 'repos/example/private-archive/contents/' + ['分组', '原始.md'].map(encodeURIComponent).join('/');
  remote.set(first, 'older-blob');
  await backup.capture(source);
  await backup.flush();
  assert.equal(writes, 1);
  assert.equal(remote.get(first), 'older-blob');
  assert.equal((await backup.status()).queued, 0);
  await backup.capture(source);
  await backup.flush();
  assert.equal(writes, 1);
});

test('holds scan findings, retries unavailable GitHub, and ignores login-bound sources', async t => {
  let online = false;
  let scanned = 0;
  const { backup, ...source } = await fixture(t, async program => {
    if (program === 'gitleaks') {
      scanned++;
      return { code: 12 };
    }
    return { code: 0, stdout: online ? 'true\tfalse\tmain' : 'false\tfalse\tmain' };
  });
  await backup.capture({ ...source, authenticated: true });
  await backup.capture({ ...source, url: 'https://another.example.org/article' });
  assert.equal((await backup.status()).queued, 0);
  await backup.capture(source);
  await backup.flush();
  assert.equal((await backup.status()).queued, 1);
  assert.equal(scanned, 0);
  online = true;
  await backup.flush();
  assert.equal((await backup.status()).held, 1);
  assert.equal((await backup.status()).queued, 0);
  assert.equal(scanned, 1);
});

test('keeps links with access token parameters in the local held queue', async t => {
  const calls = [];
  const { backup, ...source } = await fixture(t, async (program, args) => {
    calls.push([program, ...args]);
    return { code: 0, stdout: 'true\tfalse\tmain' };
  });
  await backup.capture({ ...source, markdown: 'Sample link https://example.org/?access_token=placeholder' });
  await backup.flush();
  assert.equal((await backup.status()).held, 1);
  assert.equal((await backup.status()).queued, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'gh');
  assert.ok(calls[0].every(arg => !arg.includes('/contents/')));
});

test('scans long source tokens and still detects a private email later in the note', () => {
  const chunk = 'a'.repeat(128 * 1024);
  const address = 'reader@example.test';
  const fingerprints = [createHash('sha256').update(address).digest('hex')];
  assert.equal(publicArchiveContainsPrivateData('article.md', chunk, fingerprints), false);
  assert.equal(publicArchiveContainsPrivateData('article.md', chunk + '\n' + address, fingerprints), true);
});

test('explicitly targets a public library and holds matching private data', async t => {
  const privateEmail = 'archive-owner@example.test';
  const privateEmailHash = createHash('sha256').update(privateEmail).digest('hex');
  let writes = 0;
  const { backup, ...source } = await fixture(t, async (program, args, input) => {
    if (program === 'gitleaks') return { code: 0 };
    if (args.includes('repos/example/public-library')) return { code: 0, stdout: 'false\tfalse\tmain' };
    if (!args.includes('PUT')) return { code: 1, missing: true };
    writes++;
    return { code: 0, stdout: blob(Buffer.from(JSON.parse(input).content, 'base64')) };
  }, { repository: 'example/public-library', visibility: 'public', private_email_sha256: [privateEmailHash] });
  await backup.capture({ ...source, markdown: 'Contact ' + privateEmail.toUpperCase() });
  await backup.flush();
  await backup.capture({ ...source, markdown: 'See C:\\Users\\reader\\private.md' });
  await backup.flush();
  assert.equal((await backup.status()).held, 2);
  assert.equal(writes, 0);
  await backup.capture(source);
  await backup.flush();
  assert.equal((await backup.status()).queued, 0);
  assert.equal(writes, 1);
});

test('paused sharing skips new captures and preserves the pending public backup queue', async t => {
  let sharing = false;
  let online = false;
  let remoteChecks = 0;
  let writes = 0;
  const { backup, ...source } = await fixture(t, async (program, args, input) => {
    if (program === 'gitleaks') return { code: 0 };
    if (args.includes('repos/example/public-library')) {
      remoteChecks++;
      return { code: 0, stdout: online ? 'false\tfalse\tmain' : 'true\tfalse\tmain' };
    }
    if (!args.includes('PUT')) return { code: 1, missing: true };
    writes++;
    return { code: 0, stdout: blob(Buffer.from(JSON.parse(input).content, 'base64')) };
  }, { repository: 'example/public-library', visibility: 'public' }, () => sharing);
  await backup.capture(source);
  assert.equal((await backup.status()).queued, 0);
  assert.equal(remoteChecks, 0);

  sharing = true;
  await backup.capture(source);
  await backup.flush();
  sharing = false;
  online = true;
  await backup.flush();
  assert.equal((await backup.status()).queued, 1);
  assert.equal(remoteChecks, 1);
  assert.equal(writes, 0);

  sharing = true;
  await backup.flush();
  assert.equal((await backup.status()).queued, 0);
  assert.equal(writes, 1);
});
