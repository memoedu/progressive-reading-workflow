import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import { digest, readJson, withLock, writeJson } from '../subscription-workflow/config.mjs';
import { normalizeRelativeDestinationFolder } from '../scripts/import-destination-routing.mjs';
import { findSourcePublications } from '../scripts/reading-source-library.mjs';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';
import { obsidianReadingLink } from '../subscription-workflow/reading-options.mjs';
import { replaceChecked } from '../subscription-workflow/report-archive.mjs';
import { fetchSiteText } from './network.mjs';
import { resolveSiteReadingTabLink } from './reading-links.mjs';
import { classifySiteTopics } from './topic-classification.mjs';
import { readRun, readSources, sitePaths } from './store.mjs';
import { articleTaxonomy } from './taxonomy.mjs';

const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const heading = value => clean(value).replace(/[\\`*_[\]<>#]/gu, '\\$&');
const optionalText = file => fs.readFile(file, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

function webUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const url = URL.canParse(value, base) ? new URL(value, base) : null;
  return url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
}

function linkKey(url) {
  return urlImportDedupeKey(url.href) + url.hash;
}

function entriesContent(document, entries) {
  const list = document.createElement('ul');
  for (const entry of entries) {
    const item = list.appendChild(document.createElement('li'));
    if (entry.url) {
      const link = item.appendChild(document.createElement('a'));
      link.setAttribute('href', entry.url);
      link.textContent = clean(entry.title);
    } else {
      item.textContent = clean(entry.title);
    }
    if (entry.children?.length) item.append(entriesContent(document, entry.children));
  }
  return list;
}

function htmlContent(document, recipe) {
  const selected = [...document.querySelectorAll(recipe.include)];
  if (!selected.length) throw new Error('目录选择器没有内容：' + recipe.url);
  const selectedSet = new Set(selected);
  const wrapper = document.createElement('div');
  for (const node of selected) {
    let parent = node.parentElement;
    while (parent && !selectedSet.has(parent)) parent = parent.parentElement;
    if (!parent) wrapper.append(node.cloneNode(true));
  }
  wrapper.querySelectorAll('script,style,template,iframe,object,embed,svg,img,form,noscript').forEach(node => node.remove());
  if (recipe.exclude) wrapper.querySelectorAll(recipe.exclude).forEach(node => node.remove());
  // Some book themes render a branch as a list item followed by a wrapper
  // item containing its child list. Normalize it to a single Markdown branch.
  if (recipe.nestAdjacentLists) {
    for (const list of wrapper.querySelectorAll('ol,ul')) {
      for (const item of [...list.children]) {
        const children = item.firstElementChild;
        const previous = item.previousElementSibling;
        if (previous?.matches('li') && item.matches('li') && item.children.length === 1 &&
          children?.matches('ol,ul') && item.textContent.trim() === children.textContent.trim()) {
          previous.append(children);
          item.remove();
        }
      }
    }
  }
  if (recipe.extractLinks) {
    const entries = [...wrapper.querySelectorAll('a[href]')].map(anchor => ({
      title: anchor.textContent, url: anchor.getAttribute('href')
    })).filter(entry => clean(entry.title) && entry.url);
    return entriesContent(document, entries);
  }
  return wrapper;
}

export async function captureSourceDirectory(recipe, { fetchPage = fetchSiteText } = {}) {
  const requested = webUrl(recipe.url);
  if (!requested) throw new Error('目录来源不是网页：' + recipe.url);
  const response = recipe.entries
    ? { url: requested.href, sha256: digest(JSON.stringify(recipe.entries)), body: '' }
    : await fetchPage(requested.href, { base: requested.origin });
  const url = webUrl(response.url);
  if (!url) throw new Error('目录响应缺少网页来源');
  if (requested.hash && !url.hash) url.hash = requested.hash;
  const dom = new JSDOM(response.body, { url: url.href, virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    const body = recipe.entries ? entriesContent(document, recipe.entries) : htmlContent(document, recipe);
    if (recipe.append?.length) body.append(entriesContent(document, recipe.append));
    const title = clean(recipe.title || document.querySelector('h1')?.textContent || document.title);
    if (!title) throw new Error('目录缺少标题：' + requested.href);
    const urls = [];
    for (const anchor of [...body.querySelectorAll('a[href]')]) {
      const href = webUrl(anchor.getAttribute('href'), url.href);
      const headingPermalink = href?.hash && urlImportDedupeKey(href.href) === urlImportDedupeKey(url.href) &&
        anchor.closest('h1,h2,h3,h4,h5,h6');
      if (!href || !clean(anchor.textContent) || headingPermalink) {
        anchor.replaceWith(...anchor.childNodes);
        continue;
      }
      anchor.setAttribute('href', href.href);
      urls.push(href.href);
    }
    if (!urls.length) throw new Error('目录没有可验证的条目：' + requested.href);
    return { title, url: url.href, requested: requested.href, sha256: response.sha256, evidence: recipe.evidence,
      html: body.outerHTML, urls, inferred: recipe.inferred === true, file: recipe.file,
      bindPage: recipe.bindPage !== false };
  } finally {
    dom.window.close();
  }
}

export async function inferDirectoryTopics(root, settings, inventory, options) {
  if (!inventory?.complete || !inventory.article_source?.run_id) throw new Error('推断目录需要完整的正文采集回执');
  // A site can have non-topical tags and still need a topical entry point.
  // Use a separate projection so that existing author taxonomy stays intact.
  const draft = structuredClone(inventory);
  for (const article of draft.articles) article.taxonomy = articleTaxonomy();
  const classification = await classifySiteTopics(root, settings, draft, options);
  const topics = classification.topics.map(topic => ({
    title: topic.name,
    children: draft.articles.filter(article => article.taxonomy?.primary?.name === topic.name)
      .map(article => ({ title: article.title, url: article.url }))
  }));
  if (classification.unresolved.length) {
    const unresolved = new Set(classification.unresolved.map(item => item.url));
    topics.push({ title: '待归类', children: draft.articles.filter(article => unresolved.has(article.url))
      .map(article => ({ title: article.title, url: article.url })) });
  }
  return { classification, topics };
}

function outputPath(base, name) {
  const safe = normalizeRelativeDestinationFolder(name, { required: true });
  if (!safe.endsWith('.md')) throw new Error('目录文件需要使用 .md 后缀');
  return path.join(base, safe);
}

function renderDirectory(page, context) {
  const { pagePaths, publications, linkForFile } = context;
  const links = [];
  const converter = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
  converter.addRule('directoryHeading', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => '\n\n' + '#'.repeat(Math.min(6, Number(node.tagName[1]) + 1)) + ' ' + clean(content) + '\n\n'
  });
  converter.addRule('directoryLink', {
    filter: node => node.nodeName === 'A' && node.hasAttribute('href'),
    replacement: (content, node) => {
      const url = new URL(node.getAttribute('href'));
      const key = linkKey(url);
      const directory = pagePaths.get(key);
      const publication = publications.get(urlImportDedupeKey(url.href));
      // An article fragment identifies a location on the web page. The source
      // capture does not prove that the same anchor exists in the local note.
      const target = directory !== page.path ? directory : null;
      const article = !url.hash && publication?.path;
      const file = target || article || null;
      const href = file ? linkForFile(file) : url.href;
      const label = clean(content);
      if (!label) return '';
      links.push({ url: url.href, href, ...(file ? { path: file, kind: target ? 'directory' : 'article' } : { kind: 'web' }) });
      return '[' + label + '](<' + href + '>)';
    }
  });
  const body = converter.turndown(page.html).replace(/^[ \t]+$/gmu, '').trim();
  const origin = page.inferred ? '主题层级为推断。文章沿用采集清单。' : '[原站](<' + page.url + '>)';
  return { markdown: '# ' + heading(page.title) + '\n\n' + origin + '\n\n' + body + '\n', links };
}

export async function publishSourceDirectories(root, plan, {
  apply = false, fetchPage, linkForFile, topicProducer, onProgress = async () => {}
} = {}) {
  const { sources } = await readSources(root);
  const pages = [], classifications = [];
  const readingRoot = path.resolve(root, '阅读区');
  const allPaths = new Set();
  const responses = new Map();
  const fetchOnce = (url, options) => {
    const resolved = new URL(url);
    resolved.hash = '';
    if (!responses.has(resolved.href)) responses.set(resolved.href, (fetchPage || fetchSiteText)(resolved.href, options));
    return responses.get(resolved.href);
  };
  for (const site of plan.sites) {
    const settings = site.sourceId ? sources.find(source => source.id === site.sourceId) : site;
    if (!settings) throw new Error('整站来源设置不存在：' + site.sourceId);
    if (site.runId) {
      const run = await readRun(root, site.runId);
      if (!run || run.source_id !== settings.id) throw new Error('目录与整站回执来源不符');
    }
    const base = path.join(readingRoot, normalizeRelativeDestinationFolder(settings.destination, { required: true }), '原站目录');
    // The command backfills directories from existing imports. Refuse to
    // create a new site folder just because it appears in a plan.
    if (!(await fs.stat(path.dirname(base)).catch(() => null))?.isDirectory()) {
      throw new Error('阅读区站点文件夹不存在：' + settings.destination);
    }
    const recipes = [...site.pages];
    if (site.inferTopics) {
      const run = await readRun(root, site.runId);
      const { classification, topics } = await inferDirectoryTopics(root, settings, run?.collection?.inventory, {
        producer: topicProducer, onProgress
      });
      classifications.push({ source_id: settings.id, run_id: run.id, ...classification });
      recipes.push({ file: '推断主题.md', title: '推断主题', url: settings.url, inferred: true, bindPage: false, entries: topics });
    }
    const sitePages = [];
    for (let start = 0; start < recipes.length; start += 6) {
      const batch = recipes.slice(start, start + 6);
      sitePages.push(...await Promise.all(batch.map(async recipe => {
        const file = outputPath(base, recipe.file);
        const key = process.platform === 'win32' ? file.toLowerCase() : file;
        if (allPaths.has(key)) throw new Error('目录文件重复：' + file);
        allPaths.add(key);
        const page = await captureSourceDirectory(recipe, { fetchPage: fetchOnce });
        return { ...page, path: file, site: settings.name, run_id: site.runId };
      })));
    }
    pages.push(...sitePages);
    await onProgress({ site: settings.name, captured: recipes.length });
  }

  const pagePaths = new Map();
  for (const page of pages.filter(page => page.bindPage)) {
    for (const href of [page.requested, page.url]) {
      const key = linkKey(new URL(href));
      if (pagePaths.has(key) && pagePaths.get(key) !== page.path) throw new Error('同一来源目录有多个输出：' + href);
      pagePaths.set(key, page.path);
    }
  }
  const urls = [...new Set(pages.flatMap(page => page.urls))];
  const publications = await findSourcePublications(root, urls, { zones: ['阅读区'], requireFrontmatter: true });
  const tabLink = linkForFile || await resolveSiteReadingTabLink(root);
  const context = { pagePaths, publications, linkForFile: file => tabLink?.(file) || obsidianReadingLink(file) };
  const rendered = pages.map(page => ({ ...page, ...renderDirectory(page, context) }));
  const receiptFile = path.join(sitePaths(root).home, 'source-directories.json');
  const receipt = {
    files: rendered.map(page => ({ site: page.site, run_id: page.run_id, path: page.path, source_url: page.url,
      source_sha256: page.sha256, evidence: page.evidence, sha256: digest(page.markdown), links: page.links })),
    classifications
  };
  if (!apply) return receipt;

  await withLock(receiptFile + '.lock', async () => {
    const previous = await readJson(receiptFile);
    const known = new Map(previous?.files?.map(file => [file.path, file.sha256]));
    const before = new Map();
    for (const page of rendered) {
      const text = await optionalText(page.path);
      if (text !== null && text !== page.markdown && digest(text) !== known.get(page.path)) {
        throw new Error('目录已有用户修改：' + page.path);
      }
      before.set(page.path, text);
    }
    // Check every referenced article before writing. New directories are
    // written before verification of links that point at each other.
    for (const file of new Set(rendered.flatMap(page => page.links.filter(link => link.kind === 'article').map(link => link.path)))) {
      if (!(await fs.stat(file)).isFile()) throw new Error('本地链接没有 Markdown 文件：' + file);
    }
    for (const page of rendered) await replaceChecked(page.path, before.get(page.path), page.markdown);
    for (const page of rendered) {
      if (await optionalText(page.path) !== page.markdown) throw new Error('目录回读不符：' + page.path);
    }
    const currentPaths = new Set(receipt.files.map(file => file.path));
    const sourceIds = new Set(classifications.map(item => item.source_id));
    await writeJson(receiptFile, {
      files: [...(previous?.files || []).filter(file => !currentPaths.has(file.path)), ...receipt.files],
      classifications: [...(previous?.classifications || []).filter(item => !sourceIds.has(item.source_id)), ...classifications]
    });
  });
  return receipt;
}
