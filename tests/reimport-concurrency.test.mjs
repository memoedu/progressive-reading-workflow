import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {startFixture} from '../scripts/browser-import-web/fixture.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('guarded URL refresh keeps reading identity, notes and a recoverable prior publication',{timeout:90000},async()=>{
 const fixture=await startFixture({producer:'synthetic'});
 try{
  const draft={id:'owned-url',url:fixture.sourceUrl+'/owned-refresh',title:'Owned refresh',sourceType:'url_import',pageText:'这段合成原文用于核验受保护的原位置重新处理。重新处理必须保持阅读对象身份、阅读进度与想法，并保存可恢复的旧正文。排队后如果正文或者批注发生变化，则应当停止替换并保留用户刚刚保存的修改。',destinationFolder:'Reimport',revision:0};
  const options={input_form:'written',content_profile:'natural_language',spoken_to_written:false,structure_body:false,translate:false,include_reading_guide:false};
  const post=draft=>fetch(fixture.baseUrl+'/api/highlights/import-local',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft,processing_options:options})});
  const initial=await post(draft);assert.equal(initial.status,200);const first=await initial.json(),article=first.artifacts.find(a=>a.kind==='markdown'),sidecar=first.artifacts.find(a=>a.kind==='browser_ir_metadata');
  const before=await fs.readFile(article.path),state=JSON.parse(await fs.readFile(sidecar.path,'utf8'));state.document.status='later';state.document.deferUntil='2099-01-01T00:00:00.000Z';state.readingProgress={position:23};state.articleMusing={text:'保留阅读想法'};await fs.writeFile(sidecar.path,JSON.stringify(state));const stateBytes=await fs.readFile(sidecar.path);
  const expected={markdown_sha256:hash(before),metadata_sha256:hash(stateBytes),document_id:state.document.id,revision:state.document.revision};
  const changed={...draft,pageText:draft.pageText+'\n\n这是重新处理时新增的正文段落。',importJob:{forceReimport:true,expectedPublication:{...expected,metadata_sha256:'stale'}}};
  const rejected=await post(changed);assert.notEqual(rejected.status,200);assert.equal(hash(await fs.readFile(article.path)),hash(before));
  changed.importJob.expectedPublication=expected;const response=await post(changed);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const result=await response.json(),after=JSON.parse(await fs.readFile(sidecar.path,'utf8'));
  assert.deepEqual(after.document,state.document);assert.deepEqual(after.readingProgress,state.readingProgress);assert.deepEqual(after.articleMusing,state.articleMusing);assert.equal(after.content.markdownSha256,hash(await fs.readFile(article.path)));assert.notEqual(after.content.markdownSha256,hash(before));
  const revision=result.receipt.supersedes_publication;assert.equal(revision.markdown_sha256,hash(before));assert.equal(hash(await fs.readFile(path.join(revision.recovery_dir,'previous-publication.md'))),hash(before));assert.equal(hash(await fs.readFile(path.join(revision.recovery_dir,'previous-publication.state.json'))),hash(stateBytes));assert.notEqual(result.source_metadata.standard_preprocess.output_dir,first.source_metadata.standard_preprocess.output_dir);
 }finally{await fixture.stop();}
});
async function until(fn){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await delay(20);}throw Error('reimport_guard_fixture_timeout');}
for(const change of ['body','annotations'])test('reimport preserves a concurrent '+change+' edit made during preprocessing',{timeout:90000},async()=>{
 const fixture=await startFixture({producer:'synthetic-delayed'});
 try{
  const url=fixture.sourceUrl+'/reimport-'+change,options={input_form:'written',content_profile:'natural_language',spoken_to_written:false,structure_body:false,translate:false,include_reading_guide:true};
  const draft={id:'fixture-'+change,url,title:'Concurrent reimport',sourceType:'browser_page',pageText:'完整的合成原文，用于检查导入过程中不能覆盖后来发生的人工修改。',destinationFolder:'Reimport',revision:0};
  const post=body=>fetch(fixture.baseUrl+'/api/highlights/import-local',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,processing_options:options})});
  const first=await post({draft});assert.equal(first.status,200);const result=await first.json(),artifact=result.artifacts.find(a=>a.kind==='markdown'),sidecar=result.artifacts.find(a=>a.kind==='browser_ir_metadata');
  const before=await fs.readFile(artifact.path,'utf8'),stateBefore=await fs.readFile(sidecar.path,'utf8');
  const marker=path.join(fixture.workflowRoot,'.local-ir','synthetic-producer-active.ndjson');
  const readMarker=async()=>JSON.parse((await fs.readFile(marker,'utf8')).trim().split('\n').at(-1));
  const previousMarker=(await readMarker()).at;
  const revised=draft.pageText+'\n\n第二版新增内容，用于确保重新执行预处理。';
  const pending=post({draft:{...draft,pageText:revised,revision:1,importJob:{forceReimport:true}}});
  await until(async()=>{const value=await readMarker().catch(()=>null);return value?.at>previousMarker;});
  const edited=change==='body'?before+'\n用户正在保存的正文。\n':JSON.stringify({...JSON.parse(stateBefore),articleMusing:{text:'用户新写的想法。'}});
  await fs.writeFile(change==='body'?artifact.path:sidecar.path,edited);
  const response=await pending,value=await response.json();assert.notEqual(response.status,200);assert.match(value.error,/existing_article_changed_during_processing_preserved/u);
  assert.equal(await fs.readFile(change==='body'?artifact.path:sidecar.path,'utf8'),edited);
  assert.equal(await fs.readFile(change==='body'?sidecar.path:artifact.path,'utf8'),change==='body'?stateBefore:before);
 }finally{await fixture.stop();}
});
