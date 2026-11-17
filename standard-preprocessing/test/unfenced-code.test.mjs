import test from 'node:test';
import assert from 'node:assert/strict';
import {processMaterial} from '../lib/core.mjs';

const request=markdown=>({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',source_type:'fixture',source_metadata:{source_url:'https://independent.invalid/unfenced-code',source_is_original:true},material:{markdown},user_instruction:'',processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false}});
test('unfenced code with imports, assignments and calls stays byte-identical without adding fences',async()=>{
 const code='sample = graph.make\\_series(\\[3, 6, 9\\])\nimport render.engine as painter\nfrom render.palette import tones\npainter.draw(sample, color="blue")\npainter.show()';
 const single='limit = settings.read_limit()';let seen;
 const result=await processMaterial(request('This paragraph explains why repeated measurements are required before the equipment can be used reliably in another laboratory.\n\n'+single+'\n\n'+code),{producer:{async generate(payload){seen=payload.blocks;return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(block=>({source_block_key:block.source_block_key,markdown:block.type==='code'?block.markdown:'这段文字解释了为什么必须重复测量，才能在另一实验室可靠地使用设备。'})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
 assert.equal(result.status,'completed');assert.deepEqual(seen.map(block=>block.type),['paragraph','code','code']);
 assert.ok(result.artifacts.cleaning_manifest.body_text.includes(code));assert.ok(result.artifacts.cleaning_manifest.body_text.includes(single));assert.equal(result.artifacts.cleaning_manifest.body_text.includes('```'),false);
});

test('unfenced-code recognition cannot exempt explanatory prose or mathematical definitions',async()=>{
 for(const markdown of ['import render.engine as painter\nThe equipment must be checked carefully before any measurements can be recorded because the readings may be influenced by several independent sources of error.','x = the number of observations\ny = the mean of the measurements','Import the observations into a spreadsheet and check every row carefully.\nRepeat the measurement in another laboratory before drawing conclusions.','Note (the measurements must be checked carefully before drawing a conclusion)\nWarning (the equipment may behave differently in another laboratory)','chance = probability(the samples are affected by the surrounding conditions)']){
  let seen;await processMaterial(request(markdown),{producer:{async generate(payload){seen=payload.blocks;return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(block=>({source_block_key:block.source_block_key,markdown:'这里说明如何检查观测记录，并在另一实验室重复测量后再作判断。'})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
  assert.ok(seen.every(block=>block.type!=='code'));
 }
});
