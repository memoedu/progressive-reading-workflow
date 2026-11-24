import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { pilotArticleUrl, sharedDigest, sharedSchema } from './shared-library.mjs';
import { createSharedGitHub } from './shared-library-github.mjs';
import { fetchUrlWithoutBrowser } from '../scripts/url-background-fetch.mjs';
import { htmlArticleToMarkdown } from '../scripts/browser-page-markdown.mjs';
import { publicArchiveContainsPrivateData } from '../scripts/original-markdown-backup.mjs';

const scryptAsync = promisify(scrypt);
const prefix = '/progressive-reading-sync/';
const maximumBytes = 1024 * 1024;
const sessionAge = 30 * 86400_000;
const identifier = /^[a-z0-9_-]{1,48}$/iu;

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  if (!/^application\/json(?:;|$)/iu.test(req.headers['content-type'] || '')) throw new Error('shared_json_required');
  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) throw new Error('shared_request_too_large');
  }
  const input = JSON.parse(body);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('shared_invalid_request');
  return input;
}

function secretsEqual(a, b) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export async function createSharedAccount(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 160) throw new Error('shared_password_length');
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 32)).toString('hex');
  return { salt, hash };
}

function sessionProtocol(config, now = Date.now) {
  const credentials = config.accounts || {};
  const key = config.session_secret || randomBytes(32);
  const mac = value => createHmac('sha256', key).update(value).digest('base64url');
  const account = name => identifier.test(name) && Object.hasOwn(credentials, name) ? credentials[name] : null;
  return {
    async login({ account: name, password }) {
      const saved = account(String(name || ''));
      if (typeof password !== 'string' || password.length > 160) return null;
      const hash = (await scryptAsync(password, saved?.salt || 'progressive-reading-pilot', 32)).toString('hex');
      if (!saved || !secretsEqual(hash, saved.hash)) return null;
      const payload = Buffer.from(JSON.stringify({ name, exp: now() + sessionAge, version: saved.hash.slice(0, 12) })).toString('base64url');
      return payload + '.' + mac(payload);
    },
    verify(header) {
      const value = String(header || '').match(/^Bearer ([a-z0-9_-]{10,400})\.([a-z0-9_-]{43})$/iu);
      if (!value || !secretsEqual(mac(value[1]), value[2])) return false;
      try {
        const { name, exp, version } = JSON.parse(Buffer.from(value[1], 'base64url'));
        const saved = account(name);
        return saved && Number.isSafeInteger(exp) && exp > now() && version === saved.hash.slice(0, 12);
      } catch { return false; }
    }
  };
}

async function fetchPilotArticle(url) {
  const loaded = await fetchUrlWithoutBrowser(url, { timeoutMs: 12_000, maxBytes: maximumBytes, fetchImpl: (target, options) => {
    if (!pilotArticleUrl(target)) throw new Error('shared_source_redirect_not_allowed');
    return fetch(target, options);
  } });
  if (!loaded.isHtml || loaded.fetchReceipt.authenticated_fetch !== false ||
      pilotArticleUrl(loaded.finalUrl) !== url) throw new Error('shared_source_unverified');
  return htmlArticleToMarkdown({ html: loaded.body, sourceUrl: loaded.finalUrl, title: loaded.title });
}

function checkCredentials(markdown, executable) {
  return new Promise((resolve, reject) => {
    const worker = spawn(executable, ['stdin', '--redact=100', '--no-banner', '--exit-code=12'],
      { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, timeout: 10_000 });
    worker.on('error', reject);
    worker.stdin.on('error', () => {});
    worker.on('close', code => {
      if (code === 0 || code === 12) resolve(code === 0);
      else reject(new Error('shared_credential_scan_unavailable'));
    });
    worker.stdin.end(markdown);
  });
}

export function createSharedLibraryServer({
  config, github = createSharedGitHub(config.github), fetchArticle = fetchPilotArticle,
  scan = markdown => checkCredentials(markdown, config.gitleaks), now = Date.now
}) {
  const sessions = sessionProtocol(config, now);
  const limits = new Map();
  const pending = new Map();
  const writeAvailable = Boolean(github.ready && config.gitleaks);

  function allowed(req, scope, limit) {
    const address = config.trust_proxy ? (req.headers['x-real-ip'] || req.socket.remoteAddress) : req.socket.remoteAddress;
    const minute = Math.floor(now() / 60_000);
    for (const [key, value] of limits) if (value.minute !== minute) limits.delete(key);
    const key = scope + ':' + address;
    if (limits.size >= 2000 && !limits.has(key)) return false;
    const entry = limits.get(key) || { minute, count: 0 };
    limits.set(key, entry);
    return ++entry.count <= limit;
  }

  async function write(url, direct) {
    const article = await fetchArticle(url);
    const markdown = article.markdown;
    const title = String(article.title || 'Ben Kuhn').replace(/\s+/gu, ' ').trim().slice(0, 160);
    const bytes = Buffer.byteLength(markdown || '');
    if (bytes < 200 || bytes > 700000 || markdown.length > 300000 ||
        publicArchiveContainsPrivateData(title, markdown, config.private_email_sha256) ||
        !await scan(markdown + '\n' + title)) throw new Error('shared_material_not_publication_ready');
    const sourceHash = sharedDigest(markdown);
    const sourceId = sharedDigest(url);
    const record = { schema: sharedSchema, url, title, original: {
      path: '订阅/RSS/Ben Kuhn/' + sourceId.slice(0, 24) + '.md', sha256: sourceHash
    } };
    return github.publish({ url, record, markdown, direct, submission: sourceId });
  }

  return http.createServer({ requestTimeout: 45_000, headersTimeout: 8_000 }, async (req, res) => {
    try {
      const route = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && route.pathname === prefix + 'health') {
        return json(res, 200, { status: 'ok', service: 'progressive-reading-sync', write_available: writeAvailable });
      }
      if (req.method !== 'POST' || ![prefix + 'session', prefix + 'resolve', prefix + 'status'].includes(route.pathname)) {
        return json(res, 404, { error: 'shared_route_not_found' });
      }
      const input = await readBody(req);
      if (route.pathname === prefix + 'session') {
        if (!allowed(req, 'login', 8)) return json(res, 429, { error: 'shared_login_rate_limited' });
        const token = await sessions.login(input);
        return token ? json(res, 200, { token }) : json(res, 401, { error: 'shared_login_invalid' });
      }
      const url = pilotArticleUrl(input.url);
      if (!url) return json(res, 400, { error: 'shared_source_outside_pilot' });
      const hit = await github.lookup(url);
      if (hit.record) return json(res, 200, { status: 'available', commit: hit.commit, record: hit.record });
      const direct = sessions.verify(req.headers.authorization);
      if (req.headers.authorization && !direct) return json(res, 401, { error: 'shared_session_expired' });
      if (!direct || route.pathname === prefix + 'status') {
        const previous = await github.submission?.(sharedDigest(url));
        if (previous) return json(res, 202, previous);
      }
      if (route.pathname === prefix + 'status') return json(res, 404, { error: 'shared_submission_not_found' });
      if (!writeAvailable) return json(res, 503, { error: 'shared_repository_writer_not_configured' });
      const key = url + ':' + Boolean(direct);
      if (!pending.has(key)) {
        if (!allowed(req, 'submission', direct ? 16 : 4) || pending.size >= 8) {
          return json(res, 429, { error: 'shared_submission_rate_limited' });
        }
        pending.set(key, write(url, direct).finally(() => pending.delete(key)));
      }
      const result = await pending.get(key);
      return json(res, result.status === 'available' ? 200 : 202, result);
    } catch (error) {
      const code = error instanceof SyntaxError ? 'shared_invalid_request' : error.message;
      const safe = /^shared_[a-z0-9_]+$/u.test(code || '') ? code : 'shared_service_unavailable';
      const status = ['shared_json_required', 'shared_invalid_request', 'shared_request_too_large'].includes(safe) ? 400 :
        safe === 'shared_material_not_publication_ready' ? 422 : 503;
      return json(res, status, { error: safe });
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const config = JSON.parse(await fs.readFile(process.env.PROGRESSIVE_READING_SYNC_CONFIG, 'utf8'));
  createSharedLibraryServer({ config }).listen(Number(config.port || 43182), '127.0.0.1', () => console.log('Progressive Reading Sync ready'));
}
