import fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../subscription-workflow/config.mjs';
import { mapMarkdownDestinations } from '../subscription-workflow/report-archive.mjs';
import { publicArchiveContainsPrivateData } from '../scripts/original-markdown-backup.mjs';

function portablePath(root, file) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative) ||
    !relative.includes('/原站目录/') || !relative.endsWith('.md')) return null;
  return relative;
}

function linkBetween(from, to) {
  return path.posix.relative(path.posix.dirname(from), to).split('/').map(encodeURIComponent).join('/');
}

function publicHref(href) {
  if (!URL.canParse(href)) return null;
  const url = new URL(href);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
    /\.[a-z]{2,}$/iu.test(url.hostname) && !/\.(?:local|internal|localhost)$/iu.test(url.hostname)
    ? url.href : null;
}

function stableArticlePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || !value.endsWith('.md')) return null;
  return value.split('/').every(segment => segment && !segment.startsWith('.') && !/[\u0000-\u001f:]/u.test(segment)) ? value : null;
}

function renderPortableDirectory(row, approved, articlePath, privateEmailSha256) {
    const pending = new Map();
    for (const link of row.links) {
      if (!pending.has(link.href)) pending.set(link.href, []);
      pending.get(link.href).push(link);
    }
    let badLink = false;
    let originSeen = false;
    const markdown = mapMarkdownDestinations(row.markdown, (match, destination) => {
      const href = destination.startsWith('<') ? destination.slice(1,-1) : destination;
      const origin = !originSeen && match.includes('[原站]') && href === row.source_url;
      if (origin) originSeen = true;
      const link = origin ? null : pending.get(href)?.shift();
      const nested = link?.kind === 'directory' ? approved.get(link.path)?.relative : null;
      const article = link && link.kind !== 'directory' && !new URL(link.url).hash
        ? stableArticlePath(articlePath?.(link.url)) : null;
      const target = nested || article;
      const portable = target ? linkBetween(row.relative, target) : publicHref(link?.url || href);
      if (!portable) {
        badLink = true;
        return match;
      }
      return match.replace(destination, '<' + portable + '>');
    });
    if (badLink || /obsidian:\/\//iu.test(markdown) ||
      [...pending.values()].some(items => items.some(item => item.kind !== 'web')) ||
      publicArchiveContainsPrivateData(row.relative, markdown, privateEmailSha256)) return null;
    return { path: row.relative, markdown, sha256: digest(markdown), source_url: row.source_url };
}

export async function prepareSharedSourceDirectories(root, receipt, { articlePath, privateEmailSha256 = [] } = {}) {
  const reading = path.join(root, '阅读区');
  const approved = new Map(), withheld = [];
  for (const row of receipt.files) {
    const relative = portablePath(reading, row.path);
    if (!relative) throw new Error('共享目录不在阅读区原站目录中');
    const markdown = await fs.readFile(row.path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (markdown === null || digest(markdown) !== row.sha256) {
      withheld.push({ path: row.path, reason: markdown === null ? 'missing' : 'reader_edited' });
      continue;
    }
    approved.set(row.path, { ...row, relative, markdown });
  }
  // Once a directory is held, links into it point to the original website.
  while (true) {
    const files = [];
    const count = approved.size;
    for (const row of approved.values()) {
      const portable = renderPortableDirectory(row, approved, articlePath, privateEmailSha256);
      if (portable) files.push(portable);
      else {
        approved.delete(row.path);
        withheld.push({ path: row.path, reason: 'unverified_or_private_link' });
      }
    }
    if (approved.size === count) return { files, withheld };
  }
}
