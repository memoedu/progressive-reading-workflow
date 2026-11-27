import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {digest,normalizeSource,writeJson} from '../subscription-workflow/config.mjs';
import {readCompletedRepositoryCycle,scanRepositories} from '../subscription-workflow/repositories.mjs';
import {runId} from '../site-import/store.mjs';

test('a verified repository retry is reused at the same pinned revision; another revision cannot be adopted', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'repository-cycle-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'store');
  const source=normalizeSource({kind:'github_repository',name:'Translations',url:'https://github.com/example/translations',
    mode:'original_text',history_mode:'all',repository:{url:'https://github.com/example/translations'}});
  await writeJson(path.join(root,'imports','subscriptions','active.json'),{home});
  await writeJson(path.join(home,'subscriptions.json'),{schema:'progressive-reading.subscriptions/v1',revision:1,
    enabled:true,subscriptions:[source],rss_home:path.join(root,'rss')});
  const sha='b'.repeat(40), cycle='scheduled-2026-11-28';
  const primary=`repository-${source.id}-${sha}`, oldCycle=primary+'-retry-'+digest('scheduled-2026-11-27').slice(0,10);
  const site={id:'site-original',repository:source.repository};
  const inventory={complete:true,articles:[{url:'https://example.github.io/translations/article.html'}],
    repository_snapshot:{sha,repository:source.repository}};
  const first={id:runId(primary),phase:'failed',source_id:site.id,client_request_id:primary,settings:site,
    collection:{inventory,error:'old failure'}};
  const completed={id:runId(oldCycle),phase:'completed',source_id:site.id,client_request_id:oldCycle,settings:site,
    retry_of:first.id,counts:{discovered:1,imported:0,reused:1,failed:0},collection:{inventory,verification:{
      expected:1,verified:1,records:[{...inventory.articles[0],verified:true,sha256:'e'.repeat(64)}]}}};
  const posted=[];
  const fetchImpl=async (url,init)=>{
    const route=new URL(url).pathname;
    if (init.method==='POST') {
      posted.push(JSON.parse(init.body));
      return Response.json(first);
    }
    if (route==='/api/site-imports') return Response.json({sources:[site],runs:[completed,first]});
    if (route.endsWith(first.id)) return Response.json(first);
    if (route.endsWith(completed.id)) return Response.json(completed);
    return Response.json({error:'missing'},{status:404});
  };
  const result=await scanRepositories(root,cycle,{fetchImpl,headFn:async()=>({sha})});
  assert.deepEqual(posted,[{source_id:site.id,client_request_id:primary}]);
  assert.equal(result.errors.length,0);
  assert.equal(result.results[0].run_id,completed.id);
  assert.equal(result.results[0].reused_verified_run,true);
  const scope={cycle,sourceId:source.id,commit:sha,completedRunId:completed.id};
  assert.equal((await readCompletedRepositoryCycle(root,scope,{fetchImpl})).cycle_request_id,
    primary+'-retry-'+digest(cycle).slice(0,10));
  completed.collection.inventory={...inventory,repository_snapshot:{...inventory.repository_snapshot,sha:'f'.repeat(40)}};
  await assert.rejects(readCompletedRepositoryCycle(root,scope,{fetchImpl}),/completion_not_verified/);
  assert.equal(posted.length,1);
});
