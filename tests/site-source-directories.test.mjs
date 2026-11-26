import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest, writeJson } from '../subscription-workflow/config.mjs';
import { obsidianReadingLink } from '../subscription-workflow/reading-options.mjs';
import { inferDirectoryTopics, publishSourceDirectories } from '../site-import/source-directories.mjs';
import { runPath, saveRun, sitePaths } from '../site-import/store.mjs';

const siteUrl = 'https://example.test/';
const sourceId = 'site-example';
const runId = 'site-run-' + '1'.repeat(24);
const settings = { id: sourceId, name: 'Example', url: siteUrl, destination: '整站/Example' };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-directories-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reading = path.join(root, '阅读区', '整站', 'Example');
  await fs.mkdir(reading, { recursive: true });
  await writeJson(sitePaths(root).config, { sources: [settings] });
  await saveRun(root, { id: runId, source_id: sourceId, collection: {} });
  return { root, reading };
}

test('publishes ordered directory branches with new-tab links and source-backed reuse', async t => {
  const { root, reading } = await fixture(t);
  const article = path.join(reading, '正文 #1 (marked).md');
  const original = '---\nsource_url: "https://example.test/article"\n---\n\n# Reader-edited text\n';
  await fs.writeFile(article, original);
  await writeJson(path.join(root, 'imports', 'rss-reading', 'review-ledger.v1.json'), { items: {
    article: { item_url: siteUrl + 'old', source_identity: {
      source_url: siteUrl + 'old', canonical_url: siteUrl + 'article'
    } },
    unrelated: { item_url: siteUrl + 'missing', publication: { path: article } }
  } });
  const body = [
    '<nav><a href="/navigation">Exclude</a></nav>',
    '<ol class="chapter"><li><a href="/chapter">First</a><a class="toggle" href="#">Toggle</a></li>',
    '<li><ol><li><a href="/old">Redirected article</a></li><li><a href="/missing">Web only</a></li></ol></li>',
    '<li><a href="/other">Second</a><ol><li><a href="/article">Same article</a></li></ol></li></ol>'
  ].join('');
  const chapter = '<main><ul><li><a href="/article">Repeated</a></li><li><a href="/article#detail">Source-only anchor</a></li></ul></main>';
  const fetchPage = async url => {
    const selected = url.endsWith('/chapter') ? chapter : body;
    return { url, body: selected, sha256: digest(selected) };
  };
  const plan = { sites: [{ sourceId, runId, pages: [
    { file: '目录.md', url: siteUrl, title: 'Contents', include: 'ol.chapter', exclude: 'a.toggle', nestAdjacentLists: true },
    { file: 'child/目录.md', url: siteUrl + 'chapter', title: 'First', include: 'main' }
  ] }] };
  const linkForFile = file => obsidianReadingLink(path.relative(root, file).split(path.sep).join('/'), 'fixture');
  const preview = await publishSourceDirectories(root, plan, { fetchPage, linkForFile });
  await assert.rejects(fs.stat(preview.files[0].path), { code: 'ENOENT' });
  const receipt = await publishSourceDirectories(root, plan, { apply: true, fetchPage, linkForFile });
  const [index, child] = receipt.files;
  const text = await fs.readFile(index.path, 'utf8');
  assert.match(text, /^1\. {2}\[First\]\(<obsidian:\/\/open\?[^>]+&paneType=tab>\)/mu);
  assert.match(text, /^ {4}1\. {2}\[Redirected article\]\(/mu);
  assert.doesNotMatch(text, /Exclude|Toggle/u);
  assert.match(text, /\[Web only\]\(<https:\/\/example\.test\/missing>\)/u);
  assert.deepEqual(index.links.filter(link => link.kind === 'article').map(link => link.path), [article, article]);
  assert.equal(index.links[0].path, child.path);
  assert.equal(child.links[1].href, siteUrl + 'article#detail');
  assert.equal(await fs.readFile(article, 'utf8'), original);

  await fs.appendFile(index.path, '\nReader note\n');
  plan.sites[0].pages[0].title = 'Updated contents';
  await assert.rejects(publishSourceDirectories(root, plan, { apply: true, fetchPage, linkForFile }), /目录已有用户修改/u);
  assert.match(await fs.readFile(index.path, 'utf8'), /Reader note/u);
});

test('projects verified inference separately from original article taxonomy', async t => {
  const { root } = await fixture(t);
  const url = siteUrl + 'article';
  const markdown = 'Compiler optimizations combine redundant operations.';
  const article = { url, title: 'Compiler optimizations', markdown_sha256: digest(markdown),
    taxonomy: { groups: [{ name: 'Posts', kind: '标签', path: ['Posts'] }] } };
  const unknown = { url: siteUrl + 'ambiguous', title: 'Ambiguous note', markdown_sha256: digest('Source fragment.') };
  const inventory = { complete: true, article_source: { run_id: runId }, articles: [article, unknown] };
  for (const [source, captured] of [[article, markdown], [unknown, 'Source fragment.']]) {
    await writeJson(path.join(runPath(root, runId), 'sources', digest(source.url) + '.json'), { url: source.url, markdown: captured });
  }
  const result = await inferDirectoryTopics(root, settings, inventory, { producer: async (kind, payload) => {
    if (kind === 'vocabulary') return { new_topics: [{ name: 'Compilers', description: 'Compiler design and implementation' }] };
    return { assignments: [
      { url, topic_id: payload.topics[0].id, reason: 'Article about compiler optimization',
        evidence: [{ quote: 'Compiler optimizations', field: 'body' }] },
      { url: unknown.url, topic_id: null, reason: 'Too little context to establish a topic' }
    ] };
  } });
  assert.equal(article.taxonomy.groups[0].name, 'Posts');
  assert.equal(result.classification.classified, 1);
  assert.deepEqual(result.topics, [
    { title: 'Compilers', children: [{ title: article.title, url }] },
    { title: '待归类', children: [{ title: unknown.title, url: unknown.url }] }
  ]);
});
