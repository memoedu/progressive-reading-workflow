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

test('considered positions remain attributed to the cited author rather than the narrator',async()=>{
 for(const source of ['The author considered the evidence sufficient. I disagree.','A researcher considers the sample too small. I repeated the measurement.','The writers also consider the alternative explanation. I remain uncertain.']){
  assert.equal(sourceHasAuthorAttribution(source),true);
  const result=await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',source_type:'fixture',source_metadata:{source_url:'https://example.invalid/considered-position',source_is_original:true},material:{markdown:source},user_instruction:'',processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false}},{producer:{async generate(payload){return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(block=>({source_block_key:block.source_block_key,markdown:'作者认为这些证据需要进一步讨论。我对此进行了独立核验。'})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
  assert.equal(result.status,'completed');
 }
 for(const source of ['I considered another explanation.','As a writer, I consider the result tentative.','The author’s considered opinion was discussed. I tested it again.'])assert.equal(sourceHasAuthorAttribution(source),false);
});

test('qualified author noun phrases and reporting idioms keep narrator and cited author separate',async()=>{
 for(const [source,translated] of [
  ['The author of the study explains a limitation. I repeated the test.','研究作者指出了一项限制。我重复了这项测试。'],
  ['The writer made a valid point about measurement. I checked the data.','作者对测量提出了一个合理的观点。我核查了数据。'],
  ['The authors of the book make an important point. I disagree with their inference.','书籍作者指出了一个重要观点。我不同意他们的推论。'],
  ['The authors of the article do not claim certainty. I remain unconvinced.','文章作者表示，并不声称确定无疑。我仍未被说服。']
 ]){
  assert.equal(sourceHasAuthorAttribution(source),true);
  const result=await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',source_type:'fixture',source_metadata:{source_url:'https://example.invalid/qualified-attribution',source_is_original:true},material:{markdown:source},user_instruction:'',processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false}},{producer:{async generate(payload){return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(block=>({source_block_key:block.source_block_key,markdown:translated})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
  assert.equal(result.status,'completed');
 }
 for(const source of ['I make an important point as an author.','The author of the book collected observations. I explained the result.','The author’s study points out a pattern. I interpreted it.','The authors make a prototype. I think it works.','As the author of the review, I point out the caveat.'])assert.equal(sourceHasAuthorAttribution(source),false);
});

test('perfect-aspect source reporting remains attributed without changing the narrator',async()=>{
 for(const source of ['Many authors have noted a methodological limitation. I tested the result.','The researcher has previously argued for a larger sample. I disagree.','The writers had not considered that alternative. I repeated the calculation.']){
  assert.equal(sourceHasAuthorAttribution(source),true);
  const result=await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',source_type:'fixture',source_metadata:{source_url:'https://independent.invalid/perfect-reporting',source_is_original:true},material:{markdown:source},user_instruction:'',processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false}},{producer:{async generate(payload){return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(block=>({source_block_key:block.source_block_key,markdown:'作者曾指出一个相关问题。我进行了独立检验。'})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
  assert.equal(result.status,'completed');
 }
 for(const source of ['I have noted a limitation as an author.','The author’s experiment has revealed a pattern. I explained it.','The authors have a large dataset. I considered an alternative.'])assert.equal(sourceHasAuthorAttribution(source),false);
});

test('requests directed to an author retain the narrator while later invented attribution still fails',async()=>{
 for(const [source,translated,accepted] of [
  ['I asked the author to clarify the procedure. I repeated the measurements.','我向作者提出了澄清程序的要求。我重复了测量。',true],
  ['Le pedí al autor una aclaración y repetí la prueba.','我向该作者提出了澄清问题的要求，并重复了试验。',true],
  ['I asked the author a question. I remain unconvinced.','我向作者提出了问题。作者认为我应该改变方法。',false],
  ['I explained the procedure and repeated the measurement.','作者解释了程序并重复了测量。',false]
 ]){
  const result=await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',source_type:'fixture',source_metadata:{source_url:'https://independent.invalid/author-recipient',source_is_original:true},material:{markdown:source},user_instruction:'',processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false}},{producer:{async generate(payload){return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(block=>({source_block_key:block.source_block_key,markdown:translated})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
  assert.equal(result.status,accepted?'completed':'completed_with_warnings');
  if(!accepted)assert.match(result.errors[0].message,/source_voice_shifted_to_third_person/u);
 }
 assert.equal(sourceHasAuthorAttribution('我向作者提出了一个问题。'),false);
 assert.equal(sourceHasAuthorAttribution('我向这位作者提出了问题。作者认为需要更多数据。'),true);
});
