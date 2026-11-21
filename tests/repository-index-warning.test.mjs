import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {processCollectionTask} from '../scripts/collection-import.mjs';
import {digest, writeJson} from '../subscription-workflow/config.mjs';
import {runPath, siteCounts} from '../site-import/store.mjs';
import {verifySiteCollection} from '../site-import/tasks.mjs';

test('a protected repository index leaves verified article imports completed with a warning', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'repository-index-warning-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const id = 'site-run-0123456789abcdef01234567';
  const site = 'https://example.test/translations/';
  const url = new URL('author/article.html',site).href;
  const settings = {id:'fixture',name:'Translations',destination:'Translations',processing_mode:'original_text',
    generate_index:false,repository:{url:'https://github.com/example/translations',content_root:'src'}};
  const destination = path.join(root,'阅读区',settings.destination);
  const file = path.join(destination,'author','Article.md');
  const body = '# 原文\n\n已读取的完整正文。';
  const markdown = '---\nsource_url: '+url+'\n---\n\n'+body;
  const pairIndex = path.join(destination,'原译文对照.md');
  const manual = '# 原译文对照\n\n保留我手写的对照说明。';
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,markdown);
  await fs.writeFile(pairIndex,manual);
  const taxonomy = {repository_directory:['author']};
  await writeJson(path.join(runPath(root,id),'sources',digest(url)+'.json'), {
    url,title:'Article',markdown:body,metadata:{taxonomy,repository:{url:settings.repository.url,relative_path:'author/article.md'}}
  });
  const collection = {inventory:{complete:true,articles:[{url,title:'Article',taxonomy}],article_source:{run_id:id}},batches:[],
    results:[{requested_url:url,status:'idempotent_replay',artifacts:[{kind:'markdown',path:file,sha256:digest(markdown)}]}]};
  let completion;
  const broker = {updateTaskProgress:async()=>{},completeTask:async(_id,value)=>{completion=value;}};
  await processCollectionTask({id:'fixture',requested_url:site,collection},{broker,verify:value=>verifySiteCollection(root,settings,value,id)});
  assert.equal(completion.ok,true);
  assert.equal(completion.result.status,'imported_with_warnings');
  assert.equal(completion.result.collection.verification.verified,1);
  assert.equal(completion.result.warnings[0].code,'repository_index_user_edit_preserved');
  assert.equal(siteCounts(completion.result.collection).warnings,1);
  assert.equal(await fs.readFile(pairIndex,'utf8'),manual);
});
