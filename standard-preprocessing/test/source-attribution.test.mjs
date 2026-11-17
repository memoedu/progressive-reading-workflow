import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceHasAuthorAttribution, processMaterial } from '../lib/core.mjs';

test('original English research attribution is retained without authorizing fabricated attribution', async () => {
  assert.equal(sourceHasAuthorAttribution('The author argues that controlled experiments are necessary.'),true);
  assert.equal(sourceHasAuthorAttribution('Researchers also suggest repeating the measurements.'),true);
  assert.equal(sourceHasAuthorAttribution('I measured the samples and then repeated the experiment.'),false);
  for (const hasAttribution of [true,false]) {
    const result = await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',source_type:'fixture',source_metadata:{source_url:'https://example.invalid/attribution',source_is_original:true},material:{markdown:hasAttribution?'The author argues that controlled experiments are necessary.':'I measured the samples and then repeated the experiment.'},user_instruction:'',processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false}}, {producer:{async generate(payload){return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(b=>({source_block_key:b.source_block_key,markdown:'作者指出，进行对照实验是必要的。'})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
    assert.equal(result.status,hasAttribution?'completed':'completed_with_warnings');
    if (!hasAttribution) assert.match(result.errors[0].message,/source_voice_shifted_to_third_person/u);
  }
});

test('belief and proposal attributions remain third person while the narrator stays first person',async()=>{
 for(const [source,translated] of [['I disagree with a condition the author thinks is essential. I prefer a simpler model.','我不同意作者认为不可缺少的条件。我更倾向于一个简单的模型。'],['A writer proposed a different explanation. I checked it independently.','一位作者提出了另一种解释。我进行了独立核验。'],['The author believes the effect is temporary. I remain uncertain.','作者认为这种效应是暂时的。我仍然不确定。']]){
  assert.equal(sourceHasAuthorAttribution(source),true);
  const result=await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',source_type:'fixture',source_metadata:{source_url:'https://independent.invalid/attribution',source_is_original:true},material:{markdown:source},user_instruction:'',processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false}}, {producer:{async generate(payload){return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(b=>({source_block_key:b.source_block_key,markdown:translated})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
  assert.equal(result.status,'completed');
 }
 for(const source of ['I think the effect is temporary.','I proposed a simpler model as a writer.','The author’s experiment failed. I repeated it.'])assert.equal(sourceHasAuthorAttribution(source),false);
});

test('research pointers retain attributed speech without accepting a fabricated narrator attribution',async()=>{
 const sources=[
  'The authors point to a change in the measurements. I checked the underlying data.',
  'A researcher points out a limitation of the method. I tested another approach.',
  'The writer pointed to an earlier experiment. I remain uncertain about its interpretation.',
  'The authors further pointed out a confounding factor. I disagree with their conclusion.'
 ];
 for(const source of sources){
  assert.equal(sourceHasAuthorAttribution(source),true);
  const result=await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',source_type:'fixture',source_metadata:{source_url:'https://example.invalid/research-pointer',source_is_original:true},material:{markdown:source},user_instruction:'',processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false}},{producer:{async generate(payload){return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(block=>({source_block_key:block.source_block_key,markdown:'作者指出了相关证据。我对此进行了独立核验。'})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
  assert.equal(result.status,'completed');
 }
 for(const source of ['I point to the experimental data.','I pointed out a limitation as a writer.','The author’s diagram points to the result. I explain it differently.'])assert.equal(sourceHasAuthorAttribution(source),false);
});
