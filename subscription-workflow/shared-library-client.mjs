import path from 'node:path';
import { readJson, writeJson, withLock } from './config.mjs';
import { pilotArticleUrl, sharedDigest, sharedRecord, sharedRawUrl } from './shared-library.mjs';

const statePath = root => path.join(root, '.local-ir', 'subscription-library-sync.json');

function serverEndpoint(value) {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol === 'https:' && endpoint.pathname === '/progressive-reading-sync/' &&
        !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash) return endpoint.href;
  } catch {}
  return null;
}

async function settings(root) {
  const local = await readJson(statePath(root), {});
  const endpoint = serverEndpoint(process.env.PROGRESSIVE_READING_SHARED_LIBRARY_ENDPOINT || local.endpoint);
  return { ...local, endpoint, enabled: local.enabled !== false,
    token: endpoint && endpoint === local.session_endpoint && typeof local.token === 'string' ? local.token : null };
}

function visible(state) {
  return { enabled: state.enabled, configured: Boolean(state.endpoint), signed_in: Boolean(state.token) };
}

export async function sharedLibrarySettings(root) {
  return visible(await settings(root));
}

async function request(state, route, input, fetchImpl = fetch) {
  const response = await fetchImpl(new URL(route, state.endpoint), {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(route !== 'session' && state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: JSON.stringify(input), signal: AbortSignal.timeout(40_000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'shared_sync_unavailable');
  return result;
}

export async function updateSharedLibrarySettings(root, input, fetchImpl = fetch) {
  const file = statePath(root);
  return withLock(file + '.lock', async () => {
    const saved = await readJson(file, {});
    if (typeof input.enabled === 'boolean') saved.enabled = input.enabled;
    if (input.action === 'logout') {
      delete saved.token;
      delete saved.session_endpoint;
    } else if (input.action === 'login') {
      const state = await settings(root);
      if (!state.endpoint) throw new Error('尚未配置订阅同步服务器。');
      let result;
      try { result = await request(state, 'session', { account: input.account, password: input.password }, fetchImpl); }
      catch { throw new Error('登录失败，请核对订阅账号和密码。'); }
      if (!/^[a-z0-9_-]{10,400}\.[a-z0-9_-]{43}$/iu.test(result.token || '')) throw new Error('无效的登录回执。');
      saved.token = result.token;
      saved.session_endpoint = state.endpoint;
    }
    await writeJson(file, saved);
    return sharedLibrarySettings(root);
  }, { waitMs: 2000 });
}

async function articleBytes(response) {
  if (!response.ok) throw new Error('shared_download_failed');
  const maxBytes = 700000, chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maxBytes) throw new Error('shared_download_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

export async function resolveSharedSubscription(root, url, previous, { fetchImpl = fetch } = {}) {
  const canonical = pilotArticleUrl(url);
  if (!canonical) return null;
  const state = await settings(root);
  if (!state.enabled || !state.endpoint) return null;
  const pending = previous?.status === 'pending_review';
  const result = await request(state, pending ? 'status' : 'resolve', { url: canonical }, fetchImpl);
  if (result.status === 'pending_review') {
    const link = result.pull_request || previous?.pull_request;
    return { status: result.status, ...(typeof link === 'string' &&
      /^https:\/\/github\.com\/memoedu\/progressive-reading-library\/pull\/[1-9][0-9]*$/u.test(link) ? { pull_request: link } : {}) };
  }
  if (result.status !== 'available') throw new Error('shared_sync_invalid_receipt');
  const original = sharedRecord(result.record, canonical);
  const response = await fetchImpl(sharedRawUrl(result.commit, original.original.path), { signal: AbortSignal.timeout(15_000) });
  const bytes = await articleBytes(response);
  if (sharedDigest(bytes) !== original.original.sha256) throw new Error('shared_download_hash_mismatch');
  const markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (markdown.length > 300000) throw new Error('shared_download_too_large');
  return { status: 'available', commit: result.commit, sha256: original.original.sha256,
    article: { markdown, title: original.title || '' } };
}
