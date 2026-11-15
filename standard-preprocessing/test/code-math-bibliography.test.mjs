import test from 'node:test';
import assert from 'node:assert/strict';
import {processMaterial} from '../lib/core.mjs';
import {protectTranslationBlockBatch,restoreTranslationMarkdown,translationProtectedSyntax,stripUnexpectedTranslationInlineSyntax,validateGenericTranslatedChunk,isBibliographicReferenceBlock,translationLiteralBlockKeys} from '../lib/producer.mjs';

test('code-wrapped inline and display math remain opaque throughout translation and validation',()=>{
 const source='Compare `$x$` with `$$y = x + 2$$`, then `$z$` and `$$q = z / 3$$`. This explanation must be translated without changing a literal.';
 const block={source_block_key:'independent-math',type:'paragraph',markdown:source},protection=protectTranslationBlockBatch([block]),protectedValue=protection.get(block.source_block_key);
 const tokens=[...protectedValue.values].sort((a,b)=>a.order-b.order).map(value=>value.token);
 const candidate='比较 '+tokens[0]+' 与 '+tokens[1]+'，接着比较 '+tokens[2]+' 和 '+tokens[3]+'。保留各个字面量，并翻译说明。';
 const checked=validateGenericTranslatedChunk({translations:[{source_block_key:block.source_block_key,markdown:candidate}]},[block],protection,new Set(),{requireChinese:true});
 assert.deepEqual(checked.failures,[]);const translated=checked.restored[0].markdown;
 assert.deepEqual(translationProtectedSyntax(translated,{includeMath:true}),translationProtectedSyntax(source,{includeMath:true}));
 assert.equal(translationProtectedSyntax(source,{includeMath:true}).inlineCode.length,4);assert.equal(translationProtectedSyntax(source,{includeMath:true}).displayMath.length,0);
 assert.equal(stripUnexpectedTranslationInlineSyntax(translated,source,{includeMath:true}),translated);
 assert.notDeepEqual(translationProtectedSyntax(translated.replace('x + 2','x + 9'),{includeMath:true}),translationProtectedSyntax(source,{includeMath:true}));
 assert.throws(()=>restoreTranslationMarkdown(candidate.replace(tokens[0],''),protectedValue.values));
});

test('publication accepts translated prose around opaque math code and rejects changed formula bytes',async()=>{
 const source='Compare `$r$` with `$$s = r + 3$$`, then `$t$` and `$$u = t / 5$$`. The literals must remain unchanged.';
 const translated='比较 `$r$` 与 `$$s = r + 3$$`，接着比较 `$t$` 和 `$$u = t / 5$$`。各字面量必须保持不变。';
 for(const changed of [false,true]){
  const result=await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',source_type:'fixture',source_metadata:{source_url:'https://independent.invalid/code-math',source_is_original:true},material:{markdown:source},user_instruction:'',processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false}}, {producer:{async generate(payload){return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(b=>({source_block_key:b.source_block_key,markdown:changed?translated.replace('r + 3','r + 8'):translated})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
  assert.equal(result.status,changed?'completed_with_warnings':'completed');
  if(changed)assert.match(result.errors[0].message,/protected_inline_syntax_changed/u);
 }
});

test('named journal citations remain literal while accompanying explanatory prose still requires translation',()=>{
 const citation='3. Rivera, Jordan, et al. “Observations of Signal Drift.” _Journal of Measurement_, Vol 8(2), Aug 2009: 40-57. doi:[10.1234/example](https://doi.org/10.1234/example). [↩](https://separate.example/#note-3)';
 assert.equal(isBibliographicReferenceBlock(citation),true);
 assert.equal(isBibliographicReferenceBlock('Gomez, Emilia, and Samir Quinn. 2007. “Observations of Language Change.” Proceedings of Linguistics 12 (3): 41–52. doi:10.1234/another'),true);
 assert.equal(translationLiteralBlockKeys([{source_block_key:'citation',type:'list',markdown:citation}]).has('citation'),true);
 assert.equal(isBibliographicReferenceBlock('Rivera, Jordan. “Observations of Signal Drift.” This paper explains why the measurements are biased. Vol 8, 2009. doi:10.1234/example'),false);
 assert.equal(isBibliographicReferenceBlock(citation+' The result shows a pattern that we should investigate.'),false);
});

test('fenced code stays byte-identical and extra or changed fences are rejected',()=>{
 const code='```js\nconst formula = `$s + 4$`;\n```',source='Example:\n\n'+code,translated='示例：\n\n'+code;
 assert.equal(stripUnexpectedTranslationInlineSyntax(translated,source,{includeMath:true}),translated);
 assert.deepEqual(translationProtectedSyntax(source,{includeMath:true}).fencedCode,[code]);
 assert.notDeepEqual(translationProtectedSyntax(translated.replace('s + 4','s + 5'),{includeMath:true}),translationProtectedSyntax(source,{includeMath:true}));
 assert.notDeepEqual(translationProtectedSyntax('译文\n'+code,{includeMath:true}),translationProtectedSyntax('Source prose',{includeMath:true}));
});
