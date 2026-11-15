import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {startFixture} from '../scripts/browser-import-web/fixture.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await delay(20);}throw Error('reimport_guard_fixture_timeout');}
for(const change of ['body','annotations'])test('reimport preserves a concurrent '+change+' edit made during preprocessing',{timeout:90000},async()=>{
 const fixture=await startFixture({producer:'synthetic-delayed'});
 try{
  const url=fixture.sourceUrl+'/reimport-'+change,options={input_form:'written',content_profile:'natural_language',spoken_to_written:false,structure_body:false,translate:false,include_reading_guide:true};
  const draft={id:'fixture-'+change,url,title:'Concurrent reimport',sourceType:'browser_page',pageText:'完整的合成原文，用于检查导入过程中不能覆盖后来发生的人工修改。',destinationFolder:'Reimport',revision:0};
  const post=body=>fetch(fixture.baseUrl+'/api/highlights/import-local',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,processing_options:options})});
  const first=await post({draft});assert.equal(first.status,200);const result=await first.json(),artifact=result.artifacts.find(a=>a.kind==='markdown'),sidecar=result.artifacts.find(a=>a.kind==='browser_ir_metadata');
  const before=await fs.readFile(artifact.path,'utf8'),stateBefore=await fs.readFile(sidecar.path,'utf8');
  const marker=path.join(fixture.workflowRoot,'.local-ir','synthetic-producer-active.json'),previousMarker=JSON.parse(await fs.readFile(marker,'utf8')).at;
  const revised=draft.pageText+'\n\n第二版新增内容，用于确保重新执行预处理。';
  const pending=post({draft:{...draft,pageText:revised,revision:1,importJob:{forceReimport:true}}});
  await until(async()=>{const value=await fs.readFile(marker,'utf8').then(JSON.parse).catch(()=>null);return value?.at>previousMarker;});
  const edited=change==='body'?before+'\n用户正在保存的正文。\n':JSON.stringify({...JSON.parse(stateBefore),articleMusing:{text:'用户新写的想法。'}});
  await fs.writeFile(change==='body'?artifact.path:sidecar.path,edited);
  const response=await pending,value=await response.json();assert.notEqual(response.status,200);assert.match(value.error,/existing_article_changed_during_processing_preserved/u);
  assert.equal(await fs.readFile(change==='body'?artifact.path:sidecar.path,'utf8'),edited);
  assert.equal(await fs.readFile(change==='body'?sidecar.path:artifact.path,'utf8'),change==='body'?stateBefore:before);
 }finally{await fixture.stop();}
});
