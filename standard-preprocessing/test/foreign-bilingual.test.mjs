import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPreprocessRequest,classifyPreprocessWorkflow,standardWorkflowOptions} from '../index.mjs';
import {resolveWorkflowRouteContradictions} from '../lib/producer.mjs';

const output={source_language:'bilingual',confidence:0.95,reason:'正文包含两种语言的原文及译文。'};
for(const text of ['Evidence requires repeated observation.\n\nLa evidencia requiere observación repetida.','The experiment measures the samples.\n\nL’expérience mesure les échantillons.']){
 test('foreign paired versions still require a Chinese translation: '+text.slice(0,15),async()=>{
  const request=buildPreprocessRequest({markdown:text,sourceType:'fixture',sourceMetadata:{input_form:'written',content_profile:'natural_language'},processingOptions:standardWorkflowOptions({spoken_to_written:false,structure_body:false,include_reading_guide:false})});
  const route=await classifyPreprocessWorkflow(request,{producer:{async classifyWorkflow(){return {output,api_calls:1};}},cacheDir:false});
  assert.equal(route.needs_classification,false);assert.equal(route.translation_required,true);assert.notEqual(route.source_language.value,'bilingual');
 });
}
test('Chinese original/translation pairs and explicit choices remain authoritative',async()=>{
 assert.equal(resolveWorkflowRouteContradictions(output,'Evidence requires repeated observation.\n\n证据需要反复观察。').source_language,'bilingual');
 assert.equal(resolveWorkflowRouteContradictions(output,'Foreign text',{source_language:'bilingual'}),output);
 const request=buildPreprocessRequest({markdown:'Foreign text',sourceType:'fixture',processingOptions:standardWorkflowOptions({spoken_to_written:false,structure_body:false,translate:false,include_reading_guide:false})});
 const route=await classifyPreprocessWorkflow(request,{producer:{async classifyWorkflow(){assert.fail('Explicit choices must bypass routing');}},cacheDir:false});assert.equal(route.translation_required,false);
});
