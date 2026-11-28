import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { dataPath } from '../scripts/runtime-paths.mjs';
import { digest, loadConfig, paths, readJson } from './config.mjs';

const schema = 'progressive-reading.report-draft/v1';
const cap = 4 * 1024 * 1024;
const remotePath = '/Agent/Projects/progressive-reading-workflow/subscription-workflow/report-draft-transport.mjs';
const stagePath = '/Agent/Projects/progressive-reading-workflow/subscription-workflow/scheduled-report-draft.mjs';
const execute=promisify(execFile);
const sha=/^[a-f0-9]{64}$/u;

async function reportBinding(root) {
  const binding = await readJson(path.join(paths(root).home, 'remote-report-render.json'));
  if (binding?.enabled !== true) return null;
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/u.test(binding.host || '') ||
      !/^\/Users\/[a-zA-Z0-9._-]+$/u.test(binding.home || '')) throw Error('report_draft_binding_invalid');
  return binding;
}

export async function boundReportDraft(root, cycle, kind, {readStage=stageExchange,renderRemote=renderOverSsh}={}) {
  if (!/^scheduled-\d{4}-\d{2}-\d{2}$/u.test(cycle)) return null;
  const binding=await reportBinding(root);
  if(!binding)return null;
  const command = `${binding.home}/.local/bin/node ${binding.home}${remotePath}`;
  return async input => {
    if(binding.scheduledCapture===true && ['daily','weekly'].includes(kind)) {
      const revision=(await loadConfig(root))?.revision;
      const inputSha256=digest(JSON.stringify(input));
      const result=await readStage(binding,'receive',kind,cycle,{revision,inputSha256}).catch(()=>null);
      const r=result?.receipt;
      if(r?.status==='draft_ready' && r.cycle===cycle && r.kind===kind && r.revision===revision && r.inputSha256===inputSha256 &&
        r.jobId===digest(kind+':'+cycle).slice(0,32) && sha.test(r.planSha256||'') && r.resultSha256===digest(JSON.stringify(result.draft))){
        return {draft:result.draft,receipt:{executor:'mac',origin:'scheduled_capture',cycle,revision,planSha256:r.planSha256,
          requestSha256:inputSha256,resultSha256:r.resultSha256,capturedAt:r.finishedAt}};
      }
    }
    return renderRemote(binding.host, command, cycle, input);
  };
}

async function stageExchange(binding,op,kind,cycle,body) {
  if(binding.host!=='mac-mini-tailscale' || !['daily','weekly'].includes(kind) || !/^scheduled-\d{4}-\d{2}-\d{2}$/u.test(cycle))
    throw Error('report_draft_stage_binding_invalid');
  const command=`${binding.home}/.local/bin/node ${binding.home}${stagePath} ${op} ${binding.home}/Agent/AppData/ProgressiveReading/SubscriptionReportDrafts ${kind} ${cycle}`;
  return JSON.parse(await exchange(binding.host,command,JSON.stringify(body)));
}

export async function stageReportInputs(root) {
  const binding=await reportBinding(root);
  if(binding?.scheduledCapture!==true)return [];
  const {collectReportPlans}=await import('./scheduled-report-draft.mjs');
  return Promise.all((await collectReportPlans(root)).map(async plan=>{
    const result=await stageExchange(binding,'publish',plan.kind,plan.cycle,plan);
    if(result?.planSha256!==digest(JSON.stringify(plan)))throw Error('report_draft_plan_readback_mismatch');
    return {kind:plan.kind,cycle:plan.cycle,revision:plan.revision,items:plan.input.length,missingPreviews:plan.missingPreviews,
      missingSources:plan.coverage.filter(row=>!row.jobId).map(row=>row.kind),...result};
  }));
}

export async function stageAfterSource(root) {
  const binding=await reportBinding(root);
  if(binding?.scheduledCapture!==true)return;
  if(process.platform!=='win32')return stageReportInputs(root);
  // RSS and the browser source worker share the ledger but use different
  // installed releases. Use the existing Windows reporting runtime to select.
  const transport=dataPath('ProgressiveReading','ScheduledReportsRuntime','subscription-workflow','report-draft-transport.mjs');
  const {stdout}=await execute(process.execPath,[transport,'stage',root],{windowsHide:true,timeout:150000,maxBuffer:cap});
  return JSON.parse(stdout);
}

export async function settleReportDraft(root,job,send=stageExchange) {
  const r=job.result?.draftRender;
  if(!['completed','completed_with_issues'].includes(job.status) || r?.origin!=='scheduled_capture')return;
  const binding=await reportBinding(root);
  if(binding?.scheduledCapture!==true)return;
  if((await loadConfig(root))?.revision!==r.revision)return;
  for(const key of ['daily','long_weekly']){
    const output=job.result.outputs?.[key];
    if(output?.sha256 && digest(await fs.readFile(output.path))!==output.sha256)return;
  }
  return send(binding,'ack',job.kind,job.cycle,{jobId:job.id,planSha256:r.planSha256,resultSha256:r.resultSha256});
}

function exchange(host, command, message) {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'ConnectTimeout=6', host, command],
      { windowsHide:true, timeout:25000, maxBuffer:cap }, (error, stdout) => {
        if (error) reject(Error('report_draft_remote_unavailable'));
        else resolve(stdout);
      });
    child.stdin.on('error', () => {});
    child.stdin.end(message);
  });
}

async function renderOverSsh(host, command, cycle, input) {
  const request = { schema, cycle, input };
  const wire = JSON.stringify(request);
  if (Buffer.byteLength(wire) > cap) throw Error('report_draft_input_too_large');
  const result = JSON.parse(await exchange(host, command, wire));
  const requestSha256 = digest(wire);
  if (result.schema !== schema || result.cycle !== cycle || result.requestSha256 !== requestSha256 ||
      result.resultSha256 !== digest(JSON.stringify(result.draft))) throw Error('report_draft_receipt_mismatch');
  return { draft:result.draft, receipt:{ executor:'mac', cycle, requestSha256, resultSha256:result.resultSha256 } };
}

async function main() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > cap) throw Error('report_draft_input_too_large');
    chunks.push(chunk);
  }
  const wire = Buffer.concat(chunks).toString('utf8');
  const request = JSON.parse(wire);
  if (request.schema !== schema || !/^scheduled-\d{4}-\d{2}-\d{2}$/u.test(request.cycle || '')) {
    throw Error('report_draft_request_invalid');
  }
  const { renderGeneratedReportDraft } = await import('../rss-reading/core.mjs');
  const draft = renderGeneratedReportDraft(request.input);
  const result = { schema, cycle:request.cycle, requestSha256:digest(wire), resultSha256:digest(JSON.stringify(draft)), draft };
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > cap) throw Error('report_draft_output_too_large');
  process.stdout.write(output + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const operation=process.argv[2]==='stage' ? stageReportInputs(process.argv[3]).then(value=>console.log(JSON.stringify(value))) : main();
  operation.catch(error => {
    console.error(/^\w{1,100}$/u.test(error.message) ? error.message : 'report_draft_failed');
    process.exitCode = 1;
  });
}
