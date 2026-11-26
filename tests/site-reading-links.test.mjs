import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { projectReadingLinks, sourceReadingLinks } from '../site-import/reading-links.mjs';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';

const source = { url: 'https://example.org/notes/source/', path: path.resolve('阅读区/来源.md') };
const targetUrl = 'https://example.org/articles/target/';
const records = new Map([[urlImportDedupeKey(targetUrl), {
  zone: '阅读区', path: path.resolve('阅读区/分组/目标 #1.md')
}]]);

test('matches source URLs in the reading view while retaining code, web fallbacks and the original appendix', () => {
  const markdown = [
    '---', 'translation_state: "generated_translation"', '---', '',
    '[相关文章](/articles/target/?utm_source=notes#example)',
    '[其他文章](https://example.org/missing/)',
    '![图](https://example.org/articles/target/)',
    '`[代码](https://example.org/articles/target/)`',
    '', '---', '', '## 原文', '', '[Original link](https://example.org/articles/target/)', ''
  ].join('\n');
  assert.deepEqual(sourceReadingLinks(markdown, source.url), [
    'https://example.org/articles/target/?utm_source=notes#example', 'https://example.org/missing/'
  ]);
  const result = projectReadingLinks(markdown, source, records);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].url, 'https://example.org/articles/target/?utm_source=notes#example');
  assert.match(result.markdown, /\[相关文章\]\(<%E5%88%86%E7%BB%84\/%E7%9B%AE%E6%A0%87%20%231\.md>\)/u);
  assert.equal(result.markdown.split('\n').slice(5).join('\n'), markdown.split('\n').slice(5).join('\n'));
});

test('original mode retains the captured text and adds its verified local association', () => {
  const markdown = '[Original link](' + targetUrl + ')\n';
  const result = projectReadingLinks(markdown, source, records, { preserveOriginal: true });
  assert.equal(result.links.length, 1);
  assert.ok(result.markdown.startsWith(markdown));
  assert.match(result.markdown, /## 阅读区关联/u);
});

test('local association retains inline titles and reference-link structure', () => {
  const markdown = '[related](' + targetUrl + ' "Details")\n\n[reference][t]\n\n[t]: <' + targetUrl + '> "Details"\n';
  const result = projectReadingLinks(markdown, source, records);
  assert.equal(result.links.length, 1);
  assert.match(result.markdown, /\[related\]\(<[^>]+\.md> "Details"\)/u);
  assert.match(result.markdown, /^\[t\]: <[^>]+\.md> "Details"$/mu);
});

test('page-relative article links resolve against the original page URL', () => {
  const result = projectReadingLinks('[related](../../articles/target/)\n[local section](#section)\n', source, records);
  assert.equal(result.links.length, 1);
  assert.match(result.markdown, /\[related\]\(<[^>]+\.md>\)/u);
  assert.match(result.markdown, /\[local section\]\(#section\)/u);
});
