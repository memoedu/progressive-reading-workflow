import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCHEDULE, digest, readJson, withLock, writeJson } from './config.mjs';
import { fetchText } from '../rss-source/cli.mjs';
import { normalizeUrl, validateFeedDocument } from '../rss-source/core.mjs';

const schema = 'progressive-reading.subscription-rss-capture/v1';
const maxBytes = 64 * 1024 * 1024;
const registryLimit = 256 * 1024;
const dates = /^scheduled-\d{4}-\d{2}-\d{2}$/u;
const payloadSha = body => digest(JSON.stringify(body));
const safeOriginError = error => /^http_(\d{3})/u.exec(error.message)?.[0] || 'rss_source_unavailable';

export function feedPlan(config) {
  if (!config?.enabled || !Number.isSafeInteger(config.revision)) throw new Error('rss_registry_inactive');
  const feeds = config.subscriptions.filter(source => source.kind === 'rss' && source.enabled).map(source => {
    const url = new URL(source.url);
    if (url.username || url.password) throw new Error('rss_capture_url_contains_credentials');
    return { id: source.id, url: normalizeUrl(source.url) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(feeds.map(source => source.id)).size !== feeds.length ||
      new Set(feeds.map(source => source.url)).size !== feeds.length) throw new Error('rss_capture_duplicate_source');
  return { revision: config.revision, feeds };
}

export function registryState(config) {
  if (typeof config?.enabled !== 'boolean' || !Number.isSafeInteger(config.revision) || config.revision < 1) {
    throw new Error('rss_registry_invalid');
  }
  const { revision, feeds } = feedPlan({ ...config, enabled: true });
  const projection = { enabled:config.enabled, revision,
    subscriptions:feeds.map(feed => ({ ...feed, kind:'rss', enabled:true })) };
  return { projection, revision, enabled:projection.enabled, feeds:feeds.length, sha256:payloadSha(projection) };
}

export async function publishFeedRegistry(home, input) {
  const hasOnly = (value, keys) => value && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value,key));
  if (!hasOnly(input,['enabled','revision','subscriptions']) || !Array.isArray(input.subscriptions) ||
      input.subscriptions.some(source => !hasOnly(source,['id','url','kind','enabled']) || source.kind !== 'rss' ||
        source.enabled !== true || typeof source.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/u.test(source.id) ||
        typeof source.url !== 'string' || !/^https?:\/\//u.test(source.url))) {
    throw new Error('rss_registry_projection_invalid');
  }
  const { projection, ...proposed } = registryState(input);
  const registry = path.join(home,'registry.json');
  return withLock(registry+'.lock', async () => {
    const previous = registryState(await readJson(registry));
    if (proposed.revision < previous.revision) throw new Error('stale_registry_revision');
    if (proposed.revision === previous.revision) {
      if (proposed.sha256 !== previous.sha256) throw new Error('same_revision_source_conflict');
      return { status:'already_current', ...proposed };
    }
    await writeJson(registry,projection);
    if (registryState(await readJson(registry)).sha256 !== proposed.sha256) throw new Error('rss_registry_readback_mismatch');
    return { status:'replaced', ...proposed };
  }, {waitMs:2000});
}

function files(home, cycle) {
  if (!dates.test(cycle)) throw new Error('rss_capture_cycle_invalid');
  const root = path.resolve(home, cycle);
  return {
    input: path.join(root, 'input.json'), capture: path.join(root, 'capture.json'),
    receipt: path.join(root, 'receipt.json'), consumed: path.join(root, 'consumed.json'),
    lock: path.join(root, 'capture.lock'),
  };
}

function validateCapture(record, cycle, plan) {
  const { sha256, ...body } = record || {};
  if (body.schema !== schema || body.cycle !== cycle ||
      body.planSha256 !== payloadSha(plan) || sha256 !== payloadSha(body) ||
      !Array.isArray(body.feeds) || body.feeds.length !== plan.feeds.length ||
      body.feeds.some((feed, i) => feed.id !== plan.feeds[i].id || feed.url !== plan.feeds[i].url ||
        (feed.status !== 'failed' && (feed.status !== 'completed' || digest(feed.xml || '') !== feed.xmlSha256)))) {
    throw new Error('rss_capture_identity_or_hash_mismatch');
  }
  return record;
}

export async function captureFeeds(home, cycle, config, { fetchFeed = fetchText } = {}) {
  const plan = feedPlan(config);
  const target = files(home, cycle);
  return withLock(target.lock, async () => {
    const input = await readJson(target.input);
    if (input && payloadSha(input) !== payloadSha(plan)) throw new Error('rss_capture_cycle_input_conflict');
    if (!input) await writeJson(target.input, plan);
    let record = await readJson(target.capture);
    if (!record) {
      const feeds = [];
      for (const feed of plan.feeds) {
        try {
          const response = await fetchFeed(feed.url);
          const metadata = await validateFeedDocument(response.text, response.finalUrl);
          feeds.push({ ...feed, status: 'completed', format: metadata.format, count: metadata.item_count,
            finalUrl: normalizeUrl(response.finalUrl), xml: response.text, xmlSha256: digest(response.text),
            headers: Object.fromEntries(['content-type','etag','last-modified'].map(name =>
              [name, response.response.headers.get(name) || ''])) });
        } catch (error) {
          feeds.push({ ...feed, status: 'failed', error: safeOriginError(error) });
        }
      }
      const body = { schema, cycle, planSha256: payloadSha(plan), finishedAt: new Date().toISOString(), feeds };
      if (Buffer.byteLength(JSON.stringify(body)) > maxBytes) throw new Error('rss_capture_size_limit');
      record = { ...body, sha256: payloadSha(body) };
      await writeJson(target.capture, record);
    }
    validateCapture(record, cycle, plan);
    const completed = record.feeds.filter(feed => feed.status === 'completed');
    const receipt = { schema, cycle, revision: plan.revision, finishedAt: record.finishedAt, sha256: record.sha256,
      status: completed.length === plan.feeds.length ? 'completed' : completed.length ? 'completed_with_issues' : 'failed',
      verified: true, feeds: completed.length, failed: plan.feeds.length - completed.length,
      items: completed.reduce((count, feed) => count + feed.count, 0) };
    await writeJson(target.receipt, receipt);
    return receipt;
  }, { waitMs: 5000 });
}

export async function readCapturedFeeds(file, cycle, config) {
  const info = await fs.stat(file);
  if (!info.isFile() || info.size > maxBytes + 1024 * 1024) throw new Error('rss_capture_invalid_file');
  const record = validateCapture(await readJson(file), cycle, feedPlan(config));
  const entries = new Map(record.feeds.map(feed => [feed.url, feed]));
  const completed=record.feeds.filter(feed=>feed.status==='completed').length;
  return { sha256: record.sha256, fetchedAt: record.finishedAt, completed, failed:record.feeds.length-completed, fetchFeed: async url => {
    const feed = entries.get(normalizeUrl(url));
    if (!feed || feed.status !== 'completed') throw new Error(feed?.error || 'rss_capture_source_missing');
    return { text: feed.xml, finalUrl: feed.finalUrl, response: new Response(null, { headers: feed.headers }) };
  } };
}

export async function acknowledgeCapture(home, cycle, expected) {
  const target = files(home, cycle);
  return withLock(target.lock, async () => {
    const receipt = await readJson(target.receipt);
    if (!receipt || !/^[a-f0-9]{64}$/u.test(expected?.sha256 || '') || receipt.sha256 !== expected.sha256 ||
        !/^[a-f0-9]{32}$/u.test(expected?.jobId || '') ||
        digest('rss:' + cycle).slice(0, 32) !== expected.jobId) throw new Error('rss_capture_ack_mismatch');
    const previous = await readJson(target.consumed);
    if (previous) {
      if (previous.sha256 !== expected.sha256 || previous.jobId !== expected.jobId) throw new Error('rss_capture_ack_conflict');
      return previous;
    }
    const result = { cycle, sha256: expected.sha256, jobId: expected.jobId, consumedAt: new Date().toISOString() };
    await writeJson(target.consumed, result);
    return result;
  }, { waitMs: 5000 });
}

async function main() {
  const [operation, home, arg, value] = process.argv.slice(2);
  if (!path.isAbsolute(home || '')) throw new Error('rss_capture_home_required');
  if (operation === 'registry') {
    const { projection, ...current } = registryState(await readJson(path.join(home,'registry.json')));
    return current;
  }
  if (operation === 'publish-registry') {
    process.umask(0o077);
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > registryLimit) throw new Error('rss_registry_projection_too_large');
      chunks.push(chunk);
    }
    return publishFeedRegistry(home, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
  if (operation === 'run') {
    const config = await readJson(arg);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: SCHEDULE.timezone, dateStyle: 'short' }).format(new Date());
    return captureFeeds(home, value || 'scheduled-' + date, config);
  }
  if (operation === 'ack') return acknowledgeCapture(home, arg, { sha256: value, jobId: process.argv[6] });
  if (operation === 'status') return readJson(files(home, arg).receipt);
  if (operation === 'consumed') return readJson(files(home, arg).consumed);
  if (operation === 'verify') {
    const [cycle, file, registry] = [arg, value, process.argv[6]];
    const captured = await readCapturedFeeds(file, cycle, await readJson(registry));
    return { cycle, sha256: captured.sha256, fetchedAt: captured.fetchedAt };
  }
  throw new Error('rss_capture_command_invalid');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
