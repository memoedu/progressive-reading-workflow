import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { withoutUrlCookieEnvironment } from './url-background-fetch.mjs';

const maxBytes = 2 * 1024 * 1024;
const archivePath = /^(?!\.|\/)(?!.*(?:^|\/)\.)[^\\:\x00-\x1f]+\.md$/iu;
const archiveIdentity = { name: 'Progressive Reading Archive', email: 'progressive-reading-archive@users.noreply.github.com' };
const credentialLink = /https?:\/\/[^\s<>]+(?:\?|&(?:amp;)?)(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?(?:id|key|token)|cookie|x-amz-credential)=/iu;
const readerData = /(?:\b[a-z]:[\\/](?:Users|AppData)[\\/]|(?:^|\n)(?:reader_(?:email|username|account)|browser_draft_id)\s*:|<!--\s*(?:local-ir:(?:highlight|annotation|musing)|subscriptions:archived-short))/iu;
// Bound email components so long opaque source strings cannot overflow the scanner.
const emailAddress = /(?<![a-z0-9.!#$%&'*+/=?^_\x60{|}~-])[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,126}(?![a-z0-9-]|\.[a-z0-9-])/giu;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');

function command(program, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
      env: withoutUrlCookieEnvironment(process.env)
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-8192); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: stdout.trim(), missing: /\bHTTP 404\b/u.test(stderr) }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function queuedFiles(directory) {
  const names = await fs.readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
}

function originalOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port
        && /\.[a-z]{2,}$/iu.test(url.hostname) &&
        ![...url.searchParams.keys()].some(key => /token|password|auth|cookie|secret|signature|session|(?:^|_)key$/iu.test(key))) {
      return url.origin;
    }
  } catch {}
  return null;
}

export function publicArchiveContainsPrivateData(relative, markdown, emailFingerprints = []) {
  const text = (relative + '\n' + markdown).replace(/%[a-f0-9]{2}/giu, encoded => String.fromCharCode(parseInt(encoded.slice(1), 16)));
  if (readerData.test(text) || credentialLink.test(text)) return true;
  if (!emailFingerprints.length) return false;
  return [...text.matchAll(emailAddress)].some(([email]) => emailFingerprints.includes(sha256(email.toLowerCase())));
}

export function createOriginalMarkdownBackup({ workflowRoot, readingRoot, run = command, mayWrite = () => true }) {
  const home = path.join(workflowRoot, '.local-ir', 'original-markdown-backup');
  const pending = path.join(home, 'pending');
  const held = path.join(home, 'held');
  const configPath = path.join(workflowRoot, '.local-ir', 'original-markdown-backup.json');
  let lastError = null;
  let active;
  const github = (args, input) => run('gh', ['api', '--hostname', 'github.com', ...args], input);

  async function settings() {
    const raw = await fs.readFile(configPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!raw) return null;
    const config = JSON.parse(raw);
    const visibility = config.visibility ?? 'private';
    const privateEmailSha256 = config.private_email_sha256 ?? [];
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/u.test(config.repository || '') ||
        !['private', 'public'].includes(visibility) ||
        !Array.isArray(privateEmailSha256) || !privateEmailSha256.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)) ||
        !Array.isArray(config.origins) || !config.origins.length ||
        !config.origins.every(value => typeof value === 'string' && originalOrigin(value) === value)) {
      throw new Error('invalid_backup_configuration');
    }
    return { ...config, visibility, privateEmailSha256 };
  }

  async function writeRemote(repository, relative, bytes, hash) {
    const expected = gitBlob(bytes);
    const alternatives = [relative, relative.replace(/\.md$/iu, '--原文-' + hash.slice(0, 12) + '.md')];
    for (const name of alternatives) {
      const endpoint = 'repos/' + repository + '/contents/' + name.split('/').map(encodeURIComponent).join('/');
      const current = await github([endpoint + '?ref=main', '--jq', '.sha']);
      if (current.code === 0) {
        if (current.stdout === expected) return;
        continue;
      }
      if (!current.missing) throw new Error('backup_github_read_failed');
      const payload = JSON.stringify({
        message: 'Back up captured Markdown', content: bytes.toString('base64'), branch: 'main',
        author: archiveIdentity, committer: archiveIdentity
      });
      // The API requires the previous blob SHA for updates. Omit it to create only.
      const created = await github(['--method', 'PUT', endpoint, '--input', '-', '--jq', '.content.sha'], payload);
      if (created.code !== 0 || created.stdout !== expected) throw new Error('backup_github_write_failed');
      return;
    }
    return false;
  }

  async function hold(file, name) {
    await fs.mkdir(held, { recursive: true });
    await fs.rename(file, path.join(held, name));
  }

  async function drain() {
    const config = await settings();
    if (!config || !await mayWrite(config)) return;
    const items = await queuedFiles(pending);
    if (!items.length) { lastError = null; return; }
    const remote = await github(['repos/' + config.repository, '--jq', '[.private, .archived, .default_branch] | @tsv']);
    const expectedPrivate = config.visibility === 'private';
    if (remote.code !== 0 || remote.stdout !== expectedPrivate + '\tfalse\tmain') {
      throw new Error('backup_repository_visibility_mismatch');
    }
    for (const name of items) {
      const file = path.join(pending, name);
      let item;
      try { item = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        await hold(file, name);
        continue;
      }
      if (!item || typeof item.markdown !== 'string') {
        await hold(file, name);
        continue;
      }
      const bytes = Buffer.from(item.markdown || '', 'utf8');
      if (!config.origins.includes(item.origin) || item.repository !== config.repository || !archivePath.test(item.relative)
          || !bytes.length || bytes.length > maxBytes || sha256(bytes) !== item.sha256 || credentialLink.test(item.markdown)
          || (config.visibility === 'public' && publicArchiveContainsPrivateData(item.relative, item.markdown, config.privateEmailSha256))) {
        await hold(file, name);
        continue;
      }
      const scan = await run('gitleaks', ['stdin', '--redact=100', '--no-banner', '--exit-code=12'], bytes);
      if (scan.code === 12) {
        await hold(file, name);
        continue;
      }
      if (scan.code !== 0) throw new Error('backup_credential_scan_failed');
      if (!await mayWrite(config)) return;
      const result = await writeRemote(config.repository, item.relative, bytes, item.sha256);
      if (result === false) await hold(file, name);
      else await fs.unlink(file);
    }
    lastError = null;
  }

  function flush() {
    active ||= drain().catch(error => {
      lastError = /^backup_[a-z_]+$/u.test(error.message) ? error.message : 'backup_unavailable';
    }).finally(() => { active = null; });
    return active;
  }

  return {
    async capture({ file, url, markdown, authenticated }) {
      if (authenticated !== false || typeof markdown !== 'string' || !markdown.trim()) return;
      const origin = originalOrigin(url);
      const relative = path.relative(readingRoot, file).split(path.sep).join('/');
      if (!origin || !archivePath.test(relative) || Buffer.byteLength(markdown) > maxBytes) return;
      let temp;
      try {
        const config = await settings();
        if (!config?.origins.includes(origin) || !await mayWrite(config)) return;
        const hash = sha256(markdown);
        const id = sha256([config.repository, relative, hash].join('\0'));
        await fs.mkdir(pending, { recursive: true });
        temp = path.join(pending, id + '.' + randomUUID() + '.tmp');
        await fs.writeFile(temp, JSON.stringify({ origin, repository: config.repository, relative, markdown, sha256: hash }), { flag: 'wx' });
        await fs.rename(temp, path.join(pending, id + '.json'));
        temp = null;
        void flush();
      } catch {
        lastError = 'backup_local_queue_failed';
      } finally {
        if (temp) await fs.rm(temp, { force: true }).catch(() => {});
      }
    },
    async status() {
      try {
        const config = await settings();
        const [queue, rejected] = await Promise.all([queuedFiles(pending), queuedFiles(held)]);
        return { enabled: Boolean(config) && await mayWrite(config), queued: queue.length, held: rejected.length, lastError };
      } catch {
        return { enabled: false, lastError: 'invalid_backup_configuration' };
      }
    },
    start() {
      void flush();
      setInterval(() => { void flush(); }, 60_000).unref();
    },
    flush
  };
}
