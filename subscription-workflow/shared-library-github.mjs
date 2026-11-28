import fs from 'node:fs/promises';
import { createSign } from 'node:crypto';
import { sharedRepository, sharedIndexPath, sharedRecord, sharedArticleUrl, sharedDigest, sharedOriginalRevisionPath, sharedReadingPath,
  commitPattern, sha256Pattern, sharedMaterialIndexPath, sharedMaterialRecord } from './shared-library.mjs';

const account = { name: 'Progressive Reading Archive', email: 'progressive-reading-archive@users.noreply.github.com' };
const repo = '/repos/' + sharedRepository;
const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');

export function createSharedGitHub({ appId, installationId, keyPath, fetchImpl = fetch } = {}) {
  let credential;
  let renewing;
  const ready = Boolean(appId && installationId && keyPath);

  async function api(route, { method = 'GET', body, token, missing = false } = {}) {
    const response = await fetchImpl('https://api.github.com' + route, {
      method, headers: { 'User-Agent': 'ProgressiveReadingSync', Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000)
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error('shared_github_' + response.status), { status: response.status });
    return response.json();
  }

  async function renew() {
    const now = Math.floor(Date.now() / 1000);
    const signer = createSign('RSA-SHA256');
    const message = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iat: now - 30, exp: now + 480, iss: String(appId) });
    signer.update(message);
    const assertion = message + '.' + signer.sign(await fs.readFile(keyPath), 'base64url');
    const issued = await api('/app/installations/' + installationId + '/access_tokens', {
      method: 'POST', token: assertion, body: { repositories: [sharedRepository.split('/')[1]],
        permissions: { contents: 'write', pull_requests: 'write' } }
    });
    if (!issued.token || !Number.isFinite(Date.parse(issued.expires_at))) throw new Error('shared_github_invalid_installation');
    return credential = issued;
  }

  async function token(required = false) {
    if (!ready) {
      if (required) throw new Error('shared_github_app_required');
      return undefined;
    }
    if (credential && Date.parse(credential.expires_at) > Date.now() + 60_000) return credential.token;
    renewing ||= renew().finally(() => { renewing = null; });
    return (await renewing).token;
  }

  async function lookupIndex(path, validate) {
    const auth = await token();
    const current = await api(repo + '/git/ref/heads/main', { token: auth });
    const commit = current.object?.sha;
    if (!commitPattern.test(commit || '')) throw new Error('shared_github_invalid_head');
    const entry = await api(repo + '/contents/' + path + '?ref=' + commit, { token: auth, missing: true });
    if (!entry) return { commit, record: null };
    if (entry.type !== 'file' || entry.encoding !== 'base64' || typeof entry.content !== 'string') {
      throw new Error('shared_library_invalid_index');
    }
    let record;
    try { record = JSON.parse(Buffer.from(entry.content, 'base64').toString('utf8')); }
    catch { throw new Error('shared_library_invalid_index'); }
    return { commit, record: validate(record) };
  }
  const lookup = url => lookupIndex(sharedIndexPath(url), record => sharedRecord(record, url));
  const lookupArticleHash = hash => {
    if (!sha256Pattern.test(hash || '')) throw new Error('shared_library_invalid_index');
    return lookupIndex('index/articles/' + hash + '.json', record => {
      const url = sharedArticleUrl(record?.url);
      if (!url || url !== record.url || sharedDigest(url) !== hash) throw new Error('shared_library_invalid_index');
      return sharedRecord(record, url);
    });
  };
  const lookupMaterial = hash => lookupIndex(sharedMaterialIndexPath(hash), record => sharedMaterialRecord(record, hash));

  async function publishedCommit(base, entries, auth) {
    const parent = await api(repo + '/git/commits/' + base, { token: auth });
    const tree = await api(repo + '/git/trees', {
      method: 'POST', token: auth, body: { base_tree: parent.tree.sha,
        tree: entries.map(entry => ({ mode: '100644', type: 'blob', ...entry })) }
    });
    const created = await api(repo + '/git/commits', { method: 'POST', token: auth, body: {
      message: 'Add shared subscription material', tree: tree.sha, parents: [base], author: account, committer: account
    } });
    if (!commitPattern.test(created.sha || '')) throw new Error('shared_github_invalid_commit');
    return created.sha;
  }

  const indexEntry = (path, record) => ({ path, content: JSON.stringify(record, null, 2) + '\n' });

  async function pending(submission, auth) {
    const branch = 'subscription-submissions/' + submission;
    const pullRequests = await api(repo + '/pulls?state=all&sort=created&direction=desc&head=' +
      encodeURIComponent(sharedRepository.split('/')[0] + ':' + branch), { token: auth });
    if (pullRequests.length) return { branch, pull: pullRequests[0] };
    const existing = await api(repo + '/git/ref/heads/' + branch, { token: auth, missing: true });
    return { branch, existing };
  }

  async function publish({ read, build, direct, submission, title, url }) {
      const auth = await token(true);
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await read();
        const change = await build(current.record, auth);
        if (!change.entries.length) return { status: 'available', commit: current.commit, record: current.record };
        if (direct) {
          const sha = await publishedCommit(current.commit, change.entries, auth);
          try {
            await api(repo + '/git/refs/heads/main', { method: 'PATCH', token: auth, body: { sha, force: false } });
            return { status: 'available', commit: sha, record: change.record };
          } catch (error) {
            if (![409, 422].includes(error.status)) throw error;
          }
        } else {
          const { branch, pull, existing } = await pending(submission, auth);
          if (pull?.state === 'open') return { status: 'pending_review', pull_request: pull.html_url };
          if (pull) throw new Error('shared_submission_closed');
          try {
            if (!existing) {
              const sha = await publishedCommit(current.commit, change.entries, auth);
              await api(repo + '/git/refs', { method: 'POST', token: auth, body: { ref: 'refs/heads/' + branch, sha } });
            }
            const result = await api(repo + '/pulls', { method: 'POST', token: auth, body: {
              title: 'Add shared material: ' + title.slice(0, 120), head: branch, base: 'main', body: url
            } });
            return { status: 'pending_review', pull_request: result.html_url };
          } catch (error) {
            if (![409, 422].includes(error.status)) throw error;
          }
        }
      }
      throw new Error('shared_github_publish_conflict');
  }

  return {
    ready, lookup, lookupMaterial, lookupArticleHash,
    async submission(urlHash) {
      if (!ready) return null;
      const { pull } = await pending(urlHash, await token());
      if (!pull) return null;
      if (pull.state !== 'open') throw new Error('shared_submission_closed');
      return { status: 'pending_review', pull_request: pull.html_url };
    },
    publish({ url, record, markdown, direct, submission }) {
      return publish({ url, direct, submission, title: record.title, read: () => lookup(url), build: current => current
        ? { entries: [] } : { record, entries: [{ path: record.original.path, content: markdown }, indexEntry(sharedIndexPath(url), record)] } });
    },
    publishVersion({ url, originalSha256, version, markdown }) {
      return publish({ url, direct: true, read: () => lookup(url), build: current => {
        if (current?.original.sha256 !== originalSha256) throw new Error('shared_version_original_changed');
        const existing = current.versions || [];
        if (existing.some(item => item.kind === version.kind && item.sha256 === version.sha256)) return { entries: [] };
        const record = sharedRecord({ ...current, versions: [...existing, version] }, url);
        return { record, entries: [{ path: version.path, content: markdown }, indexEntry(sharedIndexPath(url), record)] };
      } });
    },
    publishReading({ url, title, original, reading, processingSha256, optionsSha256 }) {
      const originalSha256 = sharedDigest(original);
      const readingSha256 = reading ? sharedDigest(reading) : null;
      return publish({ url, direct: true, read: () => lookup(url), build: current => {
        const entries = [];
        let changed = false;
        const originalEntry = { path: sharedOriginalRevisionPath(url, originalSha256), sha256: originalSha256 };
        const record = structuredClone(current || { schema: 'progressive-reading.shared-article/v1', url, title, original: originalEntry });
        if (!current) { entries.push({ path: originalEntry.path, content: original }); changed = true; }
        else if (current.original.sha256 !== originalSha256 && !current.original_revisions?.some(item => item.sha256 === originalSha256)) {
          record.original_revisions = [...(current.original_revisions || []), originalEntry];
          entries.push({ path: originalEntry.path, content: original });
          changed = true;
        }
        const existingReading = readingSha256 && record.reading_files?.find(item => item.original_sha256 === originalSha256 &&
          (item.processing_sha256 === processingSha256 || (optionsSha256 && item.options_sha256 === optionsSha256)));
        if (readingSha256 && !existingReading) {
          const entry = { path: sharedReadingPath(url, readingSha256), sha256: readingSha256,
            original_sha256: originalSha256, processing_sha256: processingSha256,
            ...(optionsSha256 && { options_sha256: optionsSha256 }) };
          record.reading_files = [...(record.reading_files || []), entry];
          if (!current?.reading_files?.some(item => item.sha256 === readingSha256)) entries.push({ path: entry.path, content: reading });
          changed = true;
        } else if (existingReading && optionsSha256 && !existingReading.options_sha256) {
          existingReading.options_sha256 = optionsSha256;
          changed = true;
        }
        if (changed) entries.push(indexEntry(sharedIndexPath(url), sharedRecord(record, url)));
        return { entries, record };
      } });
    },
    publishMaterial({ record, bytes, direct }) {
      return publish({ url: record.url, direct, title: record.extension.toUpperCase(), submission: 'material-' + record.sha256,
        read: () => lookupMaterial(record.sha256), build: async (current, auth) => {
          if (current) return { entries: [] };
          const blob = await api(repo + '/git/blobs', { method: 'POST', token: auth,
            body: { content: bytes.toString('base64'), encoding: 'base64' } });
          if (!commitPattern.test(blob.sha || '')) throw new Error('shared_github_invalid_blob');
          return { record, entries: [{ path: record.path, sha: blob.sha }, indexEntry(sharedMaterialIndexPath(record.sha256), record)] };
        } });
    }
  };
}
