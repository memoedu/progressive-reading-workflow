import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreprocessRequest, runStandardPreprocessingWorkflow } from '../index.mjs';
import { isBibliographicReferenceBlock } from '../lib/producer.mjs';

test('numbered journal records are identified without exempting numbered explanatory prose', () => {
  const reference = '\\[1\\] – Baker, Alex D., and Casey R. Lane. “Timing and memory.” Journal 12, no. 4 (2021): 21-27.';
  assert.equal(isBibliographicReferenceBlock(reference), true);
  assert.equal(isBibliographicReferenceBlock(reference + '\n' + reference.replace('[1', '[2')), true);
  assert.equal(isBibliographicReferenceBlock('\\[1\\] – The researchers explained why study time was not the only factor.'), false);
});

test('generated translations display both document titles instead of the first subsection', async () => {
  const request = buildPreprocessRequest({
    markdown: '## A subsection\n\nOne small example demonstrates the original idea.',
    sourceType: 'browser_capture_markdown',
    sourceMetadata: { source_url: 'https://example.org/article', title: 'The source title', source_is_original: true },
    processingOptions: {
      translate: true, include_reading_guide: false, input_form: 'written',
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
  const { result } = await runStandardPreprocessingWorkflow(request, { producer, cacheDir: false });
  assert.equal(result.translation_state, 'generated_translation');
  assert.equal(result.artifacts.reading_title, '原文标题｜The source title');
  assert.match(result.artifacts.reading_markdown, /^title: "原文标题｜The source title"$/mu);
  assert.match(result.artifacts.reading_markdown, /^# 原文标题｜The source title$/mu);
});
