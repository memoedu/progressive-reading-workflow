import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPreprocessRequest, runStandardPreprocessingWorkflow } from '../index.mjs';
import { isBibliographicReferenceBlock } from '../lib/producer.mjs';
import { bilingualReadingFilename } from '../lib/reading-filename.mjs';

test('numbered journal records are identified without exempting numbered explanatory prose', () => {
  const reference = '\\[1\\] – Baker, Alex D., and Casey R. Lane. “Timing and memory.” Journal 12, no. 4 (2021): 21-27.';
  assert.equal(isBibliographicReferenceBlock(reference), true);
  assert.equal(isBibliographicReferenceBlock(reference + '\n' + reference.replace('[1', '[2')), true);
  assert.equal(isBibliographicReferenceBlock('\\[1\\] – The researchers explained why study time was not the only factor.'), false);
  assert.equal(isBibliographicReferenceBlock('1. Baker, Alex. “Timing and memory.” Journal 12, no. 4 (2021): 21.[](https://example.org/article#one)\n2. Ibid. p. 21[](https://example.org/article#two)'), true);
  assert.equal(isBibliographicReferenceBlock('2. Ibid. The researchers observed a substantial difference in the new sample.'), false);
});

test('generated translations display both titles and publish with a bilingual automatic filename', async t => {
  const request = buildPreprocessRequest({
    markdown: '## A subsection\n\nOne small example demonstrates the original idea.',
    sourceType: 'browser_capture_markdown',
    sourceMetadata: { source_url: 'https://example.org/article', title: 'The source title', source_is_original: true },
    processingOptions: {
      translate: true, translation_mode: 'plain', include_reading_guide: false, input_form: 'written',
      content_profile: 'natural_language', spoken_to_written: false, structure_body: false
    }
  });
  const producer = { async generate(payload) {
    assert.equal(payload.document_title, 'The source title');
    return {
      provider: 'fixture', model: 'fixture',
      output: {
        reading_title: '原文标题｜The source title',
        cleaned_blocks: payload.blocks.map((block, index) => ({
          source_block_key: block.source_block_key,
          markdown: index === 0 ? '## 一个小节' : '一个简短的例子说明了原来的观点。'
        })),
        judgments: null, insights: [], translation: { is_bilingual: false, alignments: [] }
      }
    };
  } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bilingual-reading-filename-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { result, publication } = await runStandardPreprocessingWorkflow(request, {
    producer, cacheDir: false, publishPath: path.join(dir, 'automatic.md'),
    automaticFilenameSource: request.source_metadata.source_url
  });
  assert.equal(result.translation_state, 'generated_translation');
  assert.equal(result.artifacts.reading_title, '原文标题｜The source title');
  assert.match(result.artifacts.reading_markdown, /^title: "原文标题｜The source title"$/mu);
  assert.match(result.artifacts.reading_markdown, /^# 原文标题｜The source title$/mu);
  assert.match(path.basename(publication.markdown.path), /^原文标题｜The source title--[a-f0-9]{10}\.md$/u);
  await fs.access(publication.markdown.path);
  await assert.rejects(fs.access(path.join(dir, 'automatic.md')), { code: 'ENOENT' });
});

test('bilingual filenames sanitize unsafe characters and reserve space for their sidecars', () => {
  const filename = bilingualReadingFilename('学习 [一]｜Learn: Why / How?', '--browser.md');
  assert.equal(filename, '学习 一｜Learn Why How--browser.md');
  assert.equal(bilingualReadingFilename('Untranslated source title'), null);
  const long = bilingualReadingFilename('原题'.repeat(100)+'｜'+'English words '.repeat(100), '--browser.md');
  assert.match(long, /^原题.+｜English words .+--browser\.md$/u);
  assert.ok(Buffer.byteLength(long + '.browser-ir.json') <= 255);
});
