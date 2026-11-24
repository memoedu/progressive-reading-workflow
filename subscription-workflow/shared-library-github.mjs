import fs from 'node:fs/promises';
import { createSign } from 'node:crypto';
import { sharedRepository, sharedIndexPath, sharedRecord, commitPattern } from './shared-library.mjs';

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

  async function lookup(url) {
    const auth = await token();
    const current = await api(repo + '/git/ref/heads/main', { token: auth });
    const commit = current.object?.sha;
    if (!commitPattern.test(commit || '')) throw new Error('shared_github_invalid_head');
    const entry = await api(repo + '/contents/' + sharedIndexPath(url) + '?ref=' + commit, { token: auth, missing: true });
    if (!entry) return { commit, record: null };
    if (entry.type !== 'file' || entry.encoding !== 'base64' || typeof entry.content !== 'string') {
      throw new Error('shared_library_invalid_index');
    }
    let record;
    try { record = JSON.parse(Buffer.from(entry.content, 'base64').toString('utf8')); }
    catch { throw new Error('shared_library_invalid_index'); }
    return { commit, record: sharedRecord(record, url) };
  }

  async function publishedCommit(base, record, markdown, auth) {
    const parent = await api(repo + '/git/commits/' + base, { token: auth });
    const tree = await api(repo + '/git/trees', {
      method: 'POST', token: auth, body: { base_tree: parent.tree.sha, tree: [
        { path: record.original.path, mode: '100644', type: 'blob', content: markdown },
        { path: sharedIndexPath(record.url), mode: '100644', type: 'blob', content: JSON.stringify(record, null, 2) + '\n' }
      ] }
    });
    const created = await api(repo + '/git/commits', { method: 'POST', token: auth, body: {
      message: 'Add shared subscription material', tree: tree.sha, parents: [base], author: account, committer: account
    } });
    if (!commitPattern.test(created.sha || '')) throw new Error('shared_github_invalid_commit');
    return created.sha;
  }

  async function pending(submission, auth) {
    const branch = 'subscription-submissions/' + submission;
    const pullRequests = await api(repo + '/pulls?state=all&sort=created&direction=desc&head=' +
      encodeURIComponent(sharedRepository.split('/')[0] + ':' + branch), { token: auth });
    if (pullRequests.length) return { branch, pull: pullRequests[0] };
    const existing = await api(repo + '/git/ref/heads/' + branch, { token: auth, missing: true });
    return { branch, existing };
  }

  return {
    ready, lookup,
    async submission(urlHash) {
      if (!ready) return null;
      const { pull } = await pending(urlHash, await token());
      if (!pull) return null;
      if (pull.state !== 'open') throw new Error('shared_submission_closed');
      return { status: 'pending_review', pull_request: pull.html_url };
    },
    async publish({ url, record, markdown, direct, submission }) {
      const auth = await token(true);
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await lookup(url);
        if (current.record) return { status: 'available', commit: current.commit, record: current.record };
        if (direct) {
          const sha = await publishedCommit(current.commit, record, markdown, auth);
          try {
            await api(repo + '/git/refs/heads/main', { method: 'PATCH', token: auth, body: { sha, force: false } });
            return { status: 'available', commit: sha, record };
          } catch (error) {
            if (![409, 422].includes(error.status)) throw error;
          }
        } else {
          const { branch, pull, existing } = await pending(submission, auth);
          if (pull?.state === 'open') return { status: 'pending_review', pull_request: pull.html_url };
          if (pull) throw new Error('shared_submission_closed');
          try {
            if (!existing) {
              const sha = await publishedCommit(current.commit, record, markdown, auth);
              await api(repo + '/git/refs', { method: 'POST', token: auth, body: { ref: 'refs/heads/' + branch, sha } });
            }
            const result = await api(repo + '/pulls', { method: 'POST', token: auth, body: {
              title: 'Add subscription material: ' + record.title.slice(0, 120), head: branch, base: 'main', body: record.url
            } });
            return { status: 'pending_review', pull_request: result.html_url };
          } catch (error) {
            if (![409, 422].includes(error.status)) throw error;
          }
        }
      }
      throw new Error('shared_github_publish_conflict');
    }
  };
}
