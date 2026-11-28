import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {digest,initialize,paths,writeJson} from '../subscription-workflow/config.mjs';
import {boundReportDraft,settleReportDraft} from '../subscription-workflow/report-draft-transport.mjs';
import {confirmSealedReportDraft,putReportPlan,receiveSealedReportDraft,reportCycle,reportPlanSchema,sealReportDraft}
  from '../subscription-workflow/scheduled-report-draft.mjs';

const cycle='scheduled-2026-11-29';
const due=new Date('2026-11-29T21:00:00+08:00');
const hash=value=>digest(JSON.stringify(value));
const id=(kind,date=cycle)=>digest(kind+':'+date).slice(0,32);
const input=[{id:'historical-long-item',direct:true,length:7300,
  preview:{status:'ready',core:'原预览',continue_reading:{level:2}}}];
const proof={kind:'rss',jobId:id('rss'),sha256:'b'.repeat(64)};
const plan={schema:reportPlanSchema,kind:'weekly',cycle,revision:40,frozenAt:'2026-11-29T11:00:00.000Z',
  ledgerSha256:'a'.repeat(64),coverage:[proof],missingPreviews:0,input};
const candidate=(home,overrides={})=>putReportPlan(home,'weekly',cycle,{...plan,...overrides});

test('scheduled periods follow Beijing daily 09:00 and Sunday 21:00, even after a delayed start',()=>{
  assert.equal(reportCycle('daily',new Date('2026-11-29T08:59:00+08:00')),'scheduled-2026-11-28');
  assert.equal(reportCycle('daily',new Date('2026-11-29T08:59:00+08:00'),{next:true}),cycle);
  assert.equal(reportCycle('weekly',new Date('2026-11-29T20:59:00+08:00')),'scheduled-2026-11-22');
  assert.equal(reportCycle('weekly',new Date('2026-12-01T09:00:00+08:00')),cycle);
});

test('a native draft waits for complete current revision and rejects earlier overwritten inputs',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'report-draft-state-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'drafts'), registry=path.join(root,'SubscriptionFeedCapture','registry.json');
  await writeJson(registry,{revision:40});
  const run=(now=due)=>sealReportDraft(home,'weekly',cycle,{now});
  await assert.rejects(run(new Date('2026-11-29T20:59:59+08:00')),/not_due/u);
  assert.equal((await run()).reason,'missing_plan');
  await candidate(home,{coverage:[{kind:'rss',jobId:null,sha256:null}]});
  const partial=await run();
  assert.equal(partial.status,'waiting_input');
  assert.equal(partial.items,1);
  assert.equal(await receiveSealedReportDraft(home,'weekly',cycle,{revision:40,inputSha256:hash(input)}),null);
  await writeJson(registry,{revision:41});
  assert.equal((await run()).reason,'stale_revision');
  await candidate(home,{revision:41});
  assert.equal((await run()).status,'draft_ready');
  await assert.rejects(candidate(home),/stale_plan/u);
  assert.equal(await receiveSealedReportDraft(home,'weekly',cycle,{revision:41,inputSha256:hash([])}),null);
  const result=await receiveSealedReportDraft(home,'weekly',cycle,{revision:41,inputSha256:hash(input)});
  assert.equal(result.receipt.publishable,false);
  const ack={jobId:id('weekly'),planSha256:result.receipt.planSha256,resultSha256:result.receipt.resultSha256};
  const one=await confirmSealedReportDraft(home,'weekly',cycle,ack);
  assert.deepEqual(await confirmSealedReportDraft(home,'weekly',cycle,ack),one);
  await assert.rejects(candidate(home,{revision:42}),/already_consumed/u);
});

test('the original renderer uses the sealed result only for its freshly selected exact input',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'report-draft-worker-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const local=path.join(root,'local');
  const rss=path.join(root,'rss');
  await fs.mkdir(rss);
  await fs.writeFile(path.join(rss,'RSS 自动导入.md'),'\x60\x60\x60json\n{"enabled":false}\n\x60\x60\x60\n## ① 标准流程导入\n## ② 原文直接导入\n## ③ 日报与周报\n');
  const cfg=await initialize(root,{home:local,rssHome:rss,videoHome:path.join(root,'video')});
  await writeJson(paths(root).config,{...cfg,revision:40});
  await writeJson(path.join(local,'remote-report-render.json'),{enabled:true,host:'mac-mini-tailscale',home:'/Users/example',scheduledCapture:true});
  const home=path.join(root,'mac-drafts');
  await candidate(home);
  await sealReportDraft(home,'weekly',cycle,{now:due});
  let fallbacks=0;
  const render=await boundReportDraft(root,cycle,'weekly',{
    readStage:(_binding,_op,kind,period,request)=>receiveSealedReportDraft(home,kind,period,request),
    renderRemote:async()=>{fallbacks++;return {receipt:{origin:'fallback'}};}
  });
  const result=await render(input);
  assert.equal(result.receipt.origin,'scheduled_capture');
  assert.equal((await render([{...input[0],direct:false}])).receipt.origin,'fallback');
  assert.equal(fallbacks,1);
  const job={id:id('weekly'),kind:'weekly',cycle,status:'completed',result:{draftRender:result.receipt}};
  const confirm=(_binding,_op,kind,period,receipt)=>confirmSealedReportDraft(home,kind,period,receipt);
  assert.deepEqual(await settleReportDraft(root,job,confirm),await settleReportDraft(root,job,confirm));
});
