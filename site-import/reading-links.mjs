import fs from 'node:fs/promises';
import path from 'node:path';
import { codeRoot, digest, readJson, writeJson } from '../subscription-workflow/config.mjs';
import { resolveVaultLocation } from '../subscription-workflow/obsidian-links.mjs';
import { obsidianReadingLink } from '../subscription-workflow/reading-options.mjs';
import { mapMarkdownDestinations, replaceChecked } from '../subscription-workflow/report-archive.mjs';
import { findSourcePublications, sourceAliasResolver, withSourcePublication } from '../scripts/reading-source-library.mjs';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';

const optionalText = file => fs.readFile(file, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

export async function resolveSiteReadingTabLink(root) {
  if (path.resolve(root) !== codeRoot || !process.env.APPDATA) return null;
  const vault = await resolveVaultLocation(root, path.join(process.env.APPDATA, 'obsidian', 'obsidian.json'));
  if (!vault) return null;
  return file => {
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    return obsidianReadingLink(path.join(vault.workflow_path, relative).replaceAll('\\', '/'), vault.id);
  };
}

function readingBody(markdown) {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/u.exec(markdown)?.[0] || '';
  const body = markdown.slice(frontmatter.length);
  const appendix = /^translation_state: ["']?generated_translation/mu.test(frontmatter)
    ? body.search(/\r?\n---\r?\n\r?\n## 原文\r?\n/u) : -1;
  return { frontmatter, body: appendix < 0 ? body : body.slice(0, appendix),
    appendix: appendix < 0 ? '' : body.slice(appendix) };
}

function visitReadingLinks(markdown, sourceUrl, visit) {
  return mapMarkdownDestinations(markdown, (match, destination, line, index) => {
    const raw = destination.startsWith('<') ? destination.slice(1, -1) : destination;
    if (!raw || raw.startsWith('#') || !URL.canParse(raw, sourceUrl) || /!\[[^\]]*$/u.test(line.slice(0, index))) return match;
    const url = new URL(raw, sourceUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return match;
    return visit(match, url, destination);
  }, { references: true, titles: true });
}

export function sourceReadingLinks(markdown, url) {
  const urls = new Set();
  visitReadingLinks(readingBody(markdown).body, url, (match, target) => {
    urls.add(target.href);
    return match;
  });
  return [...urls];
}

export function projectReadingLinks(markdown, source, publications, { preserveOriginal = false, linkForFile } = {}) {
  const { frontmatter, body, appendix } = readingBody(markdown);
  const links = new Map();
  const projected = visitReadingLinks(body, source.url, (match, url, destination) => {
    const file = publications.get(urlImportDedupeKey(url.href));
    if (file?.zone !== '阅读区' || path.resolve(file.path) === path.resolve(source.path)) return match;
    const target = path.relative(path.dirname(source.path), file.path).split(path.sep).map(encodeURIComponent).join('/');
    const href = linkForFile?.(file.path) || target;
    links.set(url.href, { url: url.href, path: file.path, target, href });
    return preserveOriginal ? match : match.replace(destination, '<' + href + '>');
  });
  const associations = [...links.values()];
  if (preserveOriginal && associations.length) {
    const listing = associations.map(link => '- [' + path.basename(link.path, '.md').replace(/[\[\]\\]/gu, '\\$&') + '](<' + link.href + '>)');
    const separator = markdown.endsWith('\n') ? '\n' : '\n\n';
    return { markdown: markdown + separator + '## 阅读区关联\n\n' + listing.join('\n') + '\n', links: associations };
  }
  return { markdown: frontmatter + projected + appendix, links: associations };
}

export async function amendSiteReadingFile(root, row, directory, update, { resolveIdentity } = {}) {
  return withSourcePublication(root, row.url, async () => {
    const file = path.resolve(row.path);
    const source = await optionalText(file);
    const stateFile = path.join(root, '.local-ir', 'browser-document-state', path.basename(file) + '.browser-ir.json');
    const beforeState = await optionalText(stateFile);
    const state = beforeState ? JSON.parse(beforeState) : null;
    const key = digest(file);
    const journalFile = path.join(directory, key + '.json');
    const prior = await readJson(journalFile);
    const hash = source === null ? null : digest(source);
    const edited = state && (state.document?.status !== 'inbox' || state.annotations?.length ||
      state.qaCards?.length || state.articleMusing || (state.content?.markdownSha256 !== hash &&
      !(hash === prior?.sha256 && state.content?.markdownSha256 === prior?.previous_sha256)));
    if (edited || (hash !== row.sha256 && hash !== prior?.sha256)) return { ...row, links: [], preserved: true };
    if (prior && hash === prior.sha256) {
      if (state && state.content.markdownSha256 !== hash) {
        state.content.markdownSha256 = hash;
        if (prior.title) {
          state.document.title = prior.title;
          if (state.browser?.sourceMetadata) state.browser.sourceMetadata.reading_title = prior.title;
        }
        await replaceChecked(stateFile, beforeState, JSON.stringify(state, null, 2) + '\n');
      }
      return { ...row, ...prior };
    }
    const result = await update(source);
    if (result.markdown === source) return { ...row, links: result.links };
    const receipt = { sha256: digest(result.markdown), previous_sha256: hash, links: result.links,
      ...(result.title ? { title: result.title } : {}) };
    await fs.mkdir(directory, { recursive: true });
    await replaceChecked(path.join(directory, key + '-' + hash + '.md'), null, source)
      .catch(async error => {
        if (await optionalText(path.join(directory, key + '-' + hash + '.md')) !== source) throw error;
      });
    await writeJson(journalFile, receipt);
    await replaceChecked(file, source, result.markdown);
    if (state) {
      state.content.markdownSha256 = receipt.sha256;
      if (receipt.title) {
        state.document.title = receipt.title;
        if (state.browser?.sourceMetadata) state.browser.sourceMetadata.reading_title = receipt.title;
      }
      try {
        await replaceChecked(stateFile, beforeState, JSON.stringify(state, null, 2) + '\n');
      } catch (error) {
        await replaceChecked(file, result.markdown, source);
        throw error;
      }
    }
    return { ...row, ...receipt };
  }, { resolveIdentity });
}

export async function bindSiteReadingLinks(root, records, directory, { preserveOriginal = false, titleFor, linkForFile } = {}) {
  const candidates = records.filter(row => row.verified && !row.reused);
  const urls = new Set();
  for (const row of candidates) {
    const markdown = await optionalText(row.path);
    if (markdown !== null) for (const url of sourceReadingLinks(markdown, row.url)) urls.add(url);
  }
  const publications = await findSourcePublications(root, [...urls]);
  const resolveIdentity = await sourceAliasResolver(root);
  const results = [];
  for (const row of candidates) {
    results.push(await amendSiteReadingFile(root, row, directory, async markdown => {
      const projected = projectReadingLinks(markdown, row, publications, { preserveOriginal, linkForFile });
      return titleFor ? titleFor(projected, row) : projected;
    }, { resolveIdentity }));
  }
  return results;
}
