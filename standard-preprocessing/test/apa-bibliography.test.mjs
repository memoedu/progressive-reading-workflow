import test from 'node:test';
import assert from 'node:assert/strict';
import {isBibliographicReferenceBlock,translationLiteralBlockKeys,protectTranslationBlockBatch,validateGenericTranslatedChunk} from '../lib/producer.mjs';

test('APA journal author lists preserve Unicode names and citation records while prose still translates',()=>{
 const records=[
  'Dvořák, L., García, M., & Åström, K. (2011). Measuring phase noise in coupled oscillators. _Journal of Signals_, _12_(3), 45–60.',
  'Rivera, A., Brown, B., Stone, C., & Wang, D. (2007). A method for measuring drift. _Measurement Review_, _8_(2), 120.',
  'Müller, J. P. (2018). Analysis of oscillation. Journal of Systems, 14, e12345.'
 ];
 for(const markdown of records){
  assert.equal(isBibliographicReferenceBlock(markdown),true,markdown);
  const block={source_block_key:'reference',type:'paragraph',markdown},keys=translationLiteralBlockKeys([block]),protection=protectTranslationBlockBatch([block]);
  assert.equal(keys.has(block.source_block_key),true);
  assert.deepEqual(validateGenericTranslatedChunk({translations:[{source_block_key:block.source_block_key,markdown:protection.get(block.source_block_key).protectedMarkdown}]},[block],protection,keys,{requireChinese:true}).failures,[]);
  assert.equal(isBibliographicReferenceBlock(markdown+' The result shows why the measurements must be repeated.'),false);
 }
 const prose='Rivera, A. (2007). The experimental method requires connecting the equipment, checking every sensor, and repeating the measurement after carefully documenting the results and correcting any calibration errors.';
 assert.equal(isBibliographicReferenceBlock(prose),false);
 const block={source_block_key:'prose',type:'paragraph',markdown:prose},protection=protectTranslationBlockBatch([block]);
 assert.ok(validateGenericTranslatedChunk({translations:[{source_block_key:block.source_block_key,markdown:protection.get(block.source_block_key).protectedMarkdown}]},[block],protection,translationLiteralBlockKeys([block]),{requireChinese:true}).failures.some(failure=>failure.startsWith('translation_target_language_missing:')));
});

test('Spanish bibliography headings retain reference context and stop at the next peer section',()=>{
 for(const title of ['Bibliografía','Bibliografia','Referencias','Referencias bibliográficas']){
  const blocks=[{type:'heading',source_block_key:'heading',markdown:'## '+title},{type:'paragraph',source_block_key:'reference',markdown:'A. Rivera. _Introduction to signal analysis_. Technical Press.'},{type:'heading',source_block_key:'discussion',markdown:'## Discusión'},{type:'paragraph',source_block_key:'prose',markdown:'El método necesita una explicación más detallada.'}];
  assert.deepEqual([...translationLiteralBlockKeys(blocks)],['reference']);
 }
 assert.deepEqual([...translationLiteralBlockKeys([{type:'heading',source_block_key:'heading',markdown:'## Por qué las referencias importan'},{type:'paragraph',source_block_key:'prose',markdown:'El argumento necesita una explicación.'}])],[]);
});

test('escaped reference numbering preserves complete citations while numbered prose still translates',()=>{
 const reference='Rivera, A., Brown, B., Stone, C., & Wang, D. (2007). A method for measuring drift. Measurement Review, 8, 120–132.';
 const prose='These instructions explain why a careful measurement takes time and how to document each sensor before comparing the results.';
 for(const prefix of ['[64] ',String.raw`\[64\] `,'[23] – ','[7]: ']){
  assert.equal(isBibliographicReferenceBlock(prefix+reference),true);
  assert.equal(isBibliographicReferenceBlock(prefix+prose),false);
 }
});

test('a citations and references section preserves entries without requiring uniform citation formatting',()=>{
 const blocks=[
  {type:'heading',source_block_key:'heading',markdown:'#### Citations and References'},
  {type:'paragraph',source_block_key:'reference',markdown:'Baker, A. (2021). An account of the original experiment.'},
  {type:'heading',source_block_key:'discussion',markdown:'#### Discussion'},
  {type:'paragraph',source_block_key:'prose',markdown:'The experiment still requires a separate independent explanation.'}
 ];
 assert.deepEqual([...translationLiteralBlockKeys(blocks)],['reference']);
});
