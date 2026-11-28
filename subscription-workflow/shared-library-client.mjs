import fs from 'node:fs/promises';
import path from 'node:path';
import defaultSources from '../config/shared-library-server-sources.example.json' with { type: 'json' };
import { readJson, writeJson, withLock } from './config.mjs';
import { sharedArticleUrl, sharedDigest, sharedRecord, sharedRawUrl, sharedMarkdownMaxBytes, sharedMaterialRecord, sharedReadingSource, sharedRepository, commitPattern, sha256Pattern, variantKind } from './shared-library.mjs';
import { publicArchiveContainsPrivateData } from '../scripts/original-markdown-backup.mjs';
import { standardWorkflowOptions } from '../standard-preprocessing/index.mjs';
import { PROCESSOR_VERSION, PROMPT_VERSION, stableJson } from '../standard-preprocessing/lib/core.mjs';

const statePath = root => path.join(root, '.local-ir', 'subscription-library-sync.json');
const defaultEndpoint = 'https://124.221.144.155/progressive-reading-sync/';
const defaultArticleOrigins = new Set(defaultSources.public_rss.flatMap(source => source.article_origins));

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
  const endpoint = serverEndpoint(process.env.PROGRESSIVE_READING_SHARED_LIBRARY_ENDPOINT ?? local.endpoint ?? defaultEndpoint);
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
    body: JSON.stringify(input), signal: AbortSignal.timeout(route === 'article' ? 8000 : route === 'publication' ? 60_000 : 40_000)
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

async function articleBytes(response, maxBytes = sharedMarkdownMaxBytes) {
  if (!response.ok) throw new Error('shared_download_failed');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maxBytes) throw new Error('shared_download_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

export async function readSharedArticleIndex(root, { fetchImpl = fetch } = {}) {
  const state = await settings(root);
  if (!state.enabled || !state.endpoint) return null;
  const url = `https://api.github.com/repos/${sharedRepository}/git/trees/main?recursive=1`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('shared_index_unavailable');
  const result = await response.json();
  if (result.truncated !== false || !commitPattern.test(result.sha || '') || !Array.isArray(result.tree)) {
    throw new Error('shared_index_incomplete');
  }
  const keys = new Set(result.tree.flatMap(entry => {
    const match = /^index\/articles\/([a-f0-9]{64})\.json$/u.exec(entry.path);
    return entry.type === 'blob' && match ? [match[1]] : [];
  }));
  return { tree: result.sha, keys };
}

export async function resolveSharedSubscription(root, url, previous, { fetchImpl = fetch, lookupOnly = false, publicSourcesOnly = false, skipIndexLookup = false } = {}) {
  const canonical = sharedArticleUrl(url);
  if (!canonical) return null;
  const state = await settings(root);
  if (!state.enabled || !state.endpoint) return null;
  const pending = previous?.status === 'pending_review';
  const publicOrigin = defaultArticleOrigins.has(new URL(canonical).origin);
  const hashOnly = lookupOnly || (!publicOrigin && (publicSourcesOnly || state.endpoint === defaultEndpoint));
  if (skipIndexLookup && hashOnly) return null;
  let result;
  try { result = hashOnly ? await request(state, 'article', { sha256: sharedDigest(canonical) }, fetchImpl)
    : await request(state, pending ? 'status' : 'resolve', { url: canonical }, fetchImpl); }
  catch (error) {
    if (error.message === 'shared_source_outside_pilot') return { status: 'local_only', reason: 'source_not_enabled' };
    throw error;
  }
  if (result.status === 'local_only') return { status: 'local_only', reason: result.reason || 'source_not_verified' };
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
  return { status: 'available', commit: result.commit, sha256: original.original.sha256, path: original.original.path,
    article: { markdown, title: original.title || '', shared_original_sha256: original.original.sha256 } };
}

export async function publishSharedVersion(root, { url, kind, markdown, originalSha256 }, { fetchImpl = fetch } = {}) {
  const state = await settings(root);
  if (!state.enabled || !state.endpoint || !state.token) return null;
  const canonical = sharedArticleUrl(url);
  if (!canonical || !variantKind(kind) || !sha256Pattern.test(originalSha256 || '') || typeof markdown !== 'string') {
    throw new Error('shared_invalid_version');
  }
  const backup = await readJson(path.join(root, '.local-ir', 'original-markdown-backup.json'), {});
  if (publicArchiveContainsPrivateData(canonical, markdown, backup.private_email_sha256 || [])) {
    throw new Error('shared_material_not_publication_ready');
  }
  return request(state, 'variant', { url: canonical, kind, markdown, original_sha256: originalSha256 }, fetchImpl);
}

export function generatedSharedVersions(result) {
  const versions = [];
  if (result.translation_state === 'generated_translation') {
    const markdown = result.artifacts.body_blocks.map(block => block.markdown).join('\n\n').trim();
    if (markdown) versions.push({ kind: 'translation', markdown });
  }
  if (result.receipt.reading_guide?.status === 'generated') {
    const markdown = result.artifacts.reading_markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim();
    if (markdown) versions.push({ kind: 'reading_guide', markdown });
  }
  return versions;
}

export async function syncSharedVersions(root, url, originalSha256, versions) {
  const receipts = [];
  for (const version of versions) {
    try {
      const receipt = await publishSharedVersion(root, { url, originalSha256, ...version });
      if (receipt) receipts.push({ kind: version.kind, ...receipt });
    } catch (error) {
      receipts.push({ kind: version.kind, status: 'retry_wait',
        error: /^shared_[a-z0-9_]+$/u.test(error.message) ? error.message : 'shared_sync_unavailable' });
    }
  }
  return receipts;
}

export async function downloadSharedVersion(root, { url, kind, sha256 }, { fetchImpl = fetch } = {}) {
  const canonical = sharedArticleUrl(url);
  if (!canonical || !variantKind(kind) || (sha256 && !sha256Pattern.test(sha256))) throw new Error('shared_invalid_version');
  const state = await settings(root);
  if (!state.endpoint) throw new Error('shared_sync_endpoint_required');
  const result = await request(state, 'article', { sha256: sharedDigest(canonical) }, fetchImpl);
  if (result.status !== 'available') return null;
  const record = sharedRecord(result.record, canonical);
  const version = (record.versions || []).findLast(row => row.kind === kind && (!sha256 || row.sha256 === sha256));
  if (!version) return null;
  const bytes = await articleBytes(await fetchImpl(sharedRawUrl(result.commit, version.path), { signal: AbortSignal.timeout(15_000) }));
  if (sharedDigest(bytes) !== version.sha256) throw new Error('shared_download_hash_mismatch');
  return { status: 'available', commit: result.commit, version, bytes };
}

function sharedReadingOptions(kind, processingOptions) {
  return standardWorkflowOptions({ ...(['bilibili','youtube'].includes(kind) ? { input_form: 'spoken_transcript' } : {}), ...processingOptions });
}

function defaultReadingKind(url) {
  const source = sharedReadingSource(url);
  return source === 'youtube' || source === 'bilibili' ? source : 'web';
}

export function sharedReadingOptionsKey({ kind = 'web', processingOptions } = {}) {
  return sharedDigest(stableJson({ kind, options: sharedReadingOptions(kind, processingOptions) }));
}

export function sharedReadingProcessingKey({ kind = 'web', processingOptions } = {}) {
  return sharedDigest(stableJson({ kind, processor: PROCESSOR_VERSION, prompt: PROMPT_VERSION,
    options: sharedReadingOptions(kind, processingOptions) }));
}

export function publicReadingBody(markdown) {
  return markdown.replace(/^\uFEFF/u, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim();
}

function readingEntry(record, request, originalSha256, readingSha256) {
  const candidates = record.reading_files?.filter(item =>
    (!originalSha256 || item.original_sha256 === originalSha256) &&
    (!readingSha256 || item.sha256 === readingSha256)) ?? [];
  const processingSha256 = sharedReadingProcessingKey(request);
  const optionsSha256 = sharedReadingOptionsKey(request);
  return candidates.findLast(item => item.processing_sha256 === processingSha256) ??
    candidates.findLast(item => item.options_sha256 === optionsSha256);
}

async function verifiedReadingPair(commit, record, entry, fetchImpl) {
  const original = [record.original, ...(record.original_revisions || [])].find(item => item.sha256 === entry.original_sha256);
  const [originalBytes, readingBytes] = await Promise.all([verifiedReadingBytes(commit, original, fetchImpl), verifiedReadingBytes(commit, entry, fetchImpl)]);
  return { status: 'available', commit, title: record.title, original, reading: entry, originalBytes, readingBytes };
}

async function verifiedReadingBytes(commit, item, fetchImpl) {
  const bytes = await articleBytes(await fetchImpl(sharedRawUrl(commit, item.path), { signal: AbortSignal.timeout(15_000) }));
  if (sharedDigest(bytes) !== item.sha256) throw new Error('shared_download_hash_mismatch');
  return bytes;
}

export async function lookupSharedReadingArtifacts(root, { url, kind, processingOptions, originalSha256, readingSha256, includeReading = true, includeOriginal = true }, { fetchImpl = fetch } = {}) {
  const canonical = sharedArticleUrl(url);
  const state = await settings(root);
  if (!canonical || !state.enabled || !state.endpoint) return null;
  const response = await request(state, 'article', { sha256: sharedDigest(canonical) }, fetchImpl);
  if (response.status !== 'available') return null;
  const record = sharedRecord(response.record, canonical);
  const entry = includeReading && readingEntry(record, { kind:kind || defaultReadingKind(canonical), processingOptions }, originalSha256, readingSha256);
  if (entry) return verifiedReadingPair(response.commit, record, entry, fetchImpl);
  if (!includeOriginal) return null;
  const original = originalSha256
    ? [record.original, ...(record.original_revisions || [])].find(item => item.sha256 === originalSha256)
    : record.original;
  if (!original) return null;
  const originalBytes = await verifiedReadingBytes(response.commit, original, fetchImpl);
  return { status: 'available', commit: response.commit, title: record.title, original, originalBytes };
}

export async function downloadSharedReading(root, input, options) {
  return lookupSharedReadingArtifacts(root, { ...input, includeOriginal: false }, options);
}

export async function syncSharedReading(root, { url, title, kind, original, markdown, processingOptions }, { fetchImpl = fetch } = {}) {
  const canonical = sharedArticleUrl(url);
  const state = await settings(root);
  if (!canonical || !state.enabled || !state.endpoint || !state.token) {
    return { status: 'local_only', reason: !state.enabled ? 'sharing_disabled' : 'shared_account_or_source_missing' };
  }
  const reading = markdown === undefined ? undefined : publicReadingBody(markdown);
  const readingSha256 = reading === undefined ? undefined : sharedDigest(reading);
  kind ||= defaultReadingKind(canonical);
  const processingSha256 = reading === undefined ? undefined : sharedReadingProcessingKey({ kind, processingOptions });
  const optionsSha256 = reading === undefined ? undefined : sharedReadingOptionsKey({ kind, processingOptions });
  const backup = await readJson(path.join(root, '.local-ir', 'original-markdown-backup.json'), {});
  if ([original, reading].filter(Boolean).some(text => publicArchiveContainsPrivateData(canonical, text, backup.private_email_sha256 || []))) {
    return { status: 'local_only', reason: 'shared_material_not_publication_ready' };
  }
  try {
    const originalSha256 = sharedDigest(original);
    const indexed = await lookupSharedReadingArtifacts(root, { url: canonical, kind, processingOptions, originalSha256,
      readingSha256, includeReading: reading !== undefined }, { fetchImpl });
    if (indexed && (reading === undefined || indexed.reading)) {
      const { originalBytes, readingBytes, ...receipt } = indexed;
      return { ...receipt, reused: true };
    }
    const result = await request(state, 'publication', {
      url: canonical, title, original, reading, processing_sha256: processingSha256, options_sha256: optionsSha256
    }, fetchImpl);
    if (result.status === 'local_only') return result;
    if (result.status !== 'available') throw new Error('shared_sync_invalid_receipt');
    const record = sharedRecord(result.record, canonical);
    if (reading === undefined) {
      const entry = [record.original, ...(record.original_revisions || [])].find(item => item.sha256 === originalSha256);
      if (!entry) throw new Error('shared_sync_invalid_receipt');
      await verifiedReadingBytes(result.commit, entry, fetchImpl);
      return { status: 'available', commit: result.commit, title: record.title, original: entry };
    }
    const entry = readingEntry(record, { kind, processingOptions }, originalSha256, readingSha256);
    if (!entry) throw new Error('shared_sync_invalid_receipt');
    const { originalBytes, readingBytes, ...receipt } = await verifiedReadingPair(result.commit, record, entry, fetchImpl);
    return receipt;
  } catch (error) {
    if (['shared_invalid_reading', 'shared_material_not_publication_ready'].includes(error.message)) {
      return { status: 'local_only', reason: error.message };
    }
    return { status: 'retry_wait', error: /^shared_[a-z0-9_]+$/u.test(error.message) ? error.message : 'shared_sync_unavailable' };
  }
}

export async function syncSharedReadingFile(root, { file, sha256, originalOnly = false, ...request }, dependencies) {
  const bytes = await fs.readFile(file).catch(() => null);
  if (!bytes || sharedDigest(bytes) !== sha256) {
    return { status: 'local_only', reason: 'local_file_missing_or_changed' };
  }
  return syncSharedReading(root, { ...request, markdown: originalOnly ? undefined : bytes.toString('utf8') }, dependencies);
}

export async function resolveSharedMaterial(root, hash, { lookupOnly = false, fetchImpl = fetch } = {}) {
  if (!sha256Pattern.test(hash || '')) throw new Error('shared_invalid_material');
  const state = await settings(root);
  if (!state.enabled || !state.endpoint) return null;
  const result = await request(state, 'material', { sha256: hash, ...(lookupOnly ? { lookup_only: true } : {}) }, fetchImpl);
  if (result.status !== 'available') return result;
  const record = sharedMaterialRecord(result.record, hash);
  const bytes = await articleBytes(await fetchImpl(sharedRawUrl(result.commit, record.path), { signal: AbortSignal.timeout(30_000) }), record.bytes);
  if (bytes.length !== record.bytes || sharedDigest(bytes) !== hash) throw new Error('shared_download_hash_mismatch');
  return { status: result.status, commit: result.commit, record, bytes };
}
