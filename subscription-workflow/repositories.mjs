import {digest,loadConfig} from './config.mjs';
import {repositoryHead} from '../site-import/repository.mjs';
import {runId} from '../site-import/store.mjs';

const defaultEndpoint = () => process.env.PROGRESSIVE_READING_ENDPOINT || 'http://127.0.0.1:37829';
const failedPhase = phase => ['failed','completed_with_failures'].includes(phase);
const terminalPhase = phase => ['completed','failed','completed_with_failures','paused','needs_classification'].includes(phase);
const shaPattern = /^[a-f0-9]{40}$/u;
const sameRepository = (left,right) => left && right &&
  ['url','branch','content_root'].every(field => left[field] === right[field]);
const requestKey = (source,sha) => `repository-${source.id}-${sha}`;
const retryKey = (primary,cycle) => `${primary}-retry-${digest(String(cycle)).slice(0,10)}`;

function apiClient({fetchImpl=globalThis.fetch,endpoint=defaultEndpoint()}={}) {
  return async (route,input,{allowMissing=false}={}) => {
    const init={signal:AbortSignal.timeout(45000)};
    if (input) Object.assign(init,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    const response=await fetchImpl(endpoint+route,init);
    if (allowMissing && response.status===404) return null;
    const data=await response.json();
    if (!response.ok) throw Error(data.error || 'repository_import_api_'+response.status);
    return data;
  };
}

async function readSiteRun(api,id,options) {
  if (!/^site-run-[a-f0-9]{24}$/u.test(id || '')) throw Error('repository_run_id_invalid');
  return api('/api/site-imports/runs/'+id+'?view=compact',null,options);
}

function verifiedRun(run,{source,site,primary,sha}) {
  const inventory=run.collection?.inventory;
  const verification=run.collection?.verification;
  const key=run.client_request_id || '';
  const isRetry=key.startsWith(primary+'-retry-') && /^[a-f0-9]{10}$/u.test(key.slice(primary.length+7));
  const count=inventory?.articles?.length;
  return run.phase==='completed' && run.source_id===site.id && run.id===runId(key) &&
    (key===primary || (isRetry && run.retry_of===runId(primary))) &&
    sameRepository(run.settings?.repository,source.repository) &&
    inventory?.complete===true && inventory.repository_snapshot?.sha===sha &&
    sameRepository(inventory.repository_snapshot.repository,source.repository) &&
    Number.isSafeInteger(count) && count>0 && run.counts?.discovered===count && run.counts.failed===0 &&
    verification?.expected===count && verification.verified===count && verification.records?.length===count &&
    new Set(verification.records.map(row=>row.url)).size===count &&
    verification.records.every(row=>row.verified===true && /^[a-f0-9]{64}$/u.test(row.sha256 || ''));
}

function resultRow(source,sha,run,extra={}) {
  return {subscription_id:source.id,commit:sha,run_id:run.id,phase:run.phase,counts:run.counts,...extra};
}

// Reconcile one exact scope through the original application's read-only API.
export async function readCompletedRepositoryCycle(root,{cycle,sourceId,commit,completedRunId},options={}) {
  if (!/^scheduled-\d{4}-\d{2}-\d{2}$/u.test(cycle || '') || !shaPattern.test(commit || '')) {
    throw Error('repository_recovery_scope_invalid');
  }
  const config=await loadConfig(root);
  const source=config?.subscriptions.find(row=>row.id===sourceId && row.enabled && row.kind==='github_repository');
  if (!source) throw Error('repository_recovery_source_unavailable');
  const api=apiClient(options);
  const listing=await api('/api/site-imports');
  const site=listing.sources.find(row=>sameRepository(row.repository,source.repository));
  if (!site) throw Error('repository_recovery_site_unavailable');
  const runs=[...(listing.runs || []),site.last_run].filter(run=>run?.source_id===site.id);
  if (runs.some(run=>!terminalPhase(run.phase))) throw Error('repository_recovery_source_in_flight');
  const primary=requestKey(source,commit);
  const initial=await readSiteRun(api,runId(primary));
  if (!failedPhase(initial.phase) || initial.client_request_id!==primary || initial.source_id!==site.id ||
      !sameRepository(initial.settings?.repository,source.repository) || initial.collection?.inventory?.repository_snapshot?.sha!==commit) {
    throw Error('repository_recovery_primary_receipt_mismatch');
  }
  const completed=await readSiteRun(api,completedRunId);
  if (!verifiedRun(completed,{source,site,primary,sha:commit}) || (completed.collection.verification.source_relations?.upstream_changes || 0)>0) {
    throw Error('repository_recovery_completion_not_verified');
  }
  const key=retryKey(primary,cycle);
  const alreadyRecorded=await readSiteRun(api,runId(key),{allowMissing:true});
  if (alreadyRecorded && alreadyRecorded.id!==completed.id) throw Error('repository_recovery_cycle_receipt_conflict');
  return {cycle,cycle_request_id:key,cycle_native_run_id:runId(key),primary_run_id:initial.id,site_id:site.id,
    source_url:source.url,source_revision:config.revision,original_error:initial.collection?.error || null,
    verification:{expected:completed.collection.verification.expected,verified:completed.collection.verification.verified},
    completed_at:completed.updated_at, result:resultRow(source,commit,completed,{reused_verified_run:true})};
}

// Reuse the application's persistent site-import requests and their recovery IDs.
export async function scanRepositories(root,cycle,{fetchImpl,headFn=repositoryHead,endpoint}={}) {
  const config=await loadConfig(root),results=[],errors=[];
  const api=apiClient({fetchImpl,endpoint});
  for (const source of config?.subscriptions.filter(row=>row.enabled && row.kind==='github_repository') || []) {
    try {
      const head=await headFn(source.repository);
      if (!shaPattern.test(head.sha || '')) throw Error('repository_head_sha_invalid');
      const listing=await api('/api/site-imports');
      let site=listing.sources.find(row=>sameRepository(row.repository,source.repository));
      if (!site) {
        const saved=await api('/api/site-imports/source',{revision:listing.revision,source:{name:source.name,url:source.repository.public_base,
          scope:'documents',destination:source.destination,processing_mode:'original_text',generate_guide:false,generate_index:false,repository:source.repository}});
        site=saved.source;
      }
      const primary=requestKey(source,head.sha);
      let run=await api('/api/site-imports/start',{source_id:site.id,client_request_id:primary});
      if (failedPhase(run.phase)) {
        if (run.id!==runId(primary)) throw Error('repository_retry_scope_mismatch');
        const key=retryKey(primary,cycle);
        const candidate=listing.runs?.find(row=>row.phase==='completed' && row.source_id===site.id &&
          row.retry_of===run.id && row.client_request_id?.startsWith(primary+'-retry-'));
        const completed=candidate && await readSiteRun(api,candidate.id);
        if (completed && verifiedRun(completed,{source,site,primary,sha:head.sha})) {
          run={...completed,source_relations:completed.collection.verification.source_relations,reused_verified_run:true};
        } else {
          run=await api('/api/site-imports/start',{source_id:site.id,retry_run_id:run.id,client_request_id:key});
        }
      }
      if (failedPhase(run.phase)) errors.push({subscription_id:source.id,url:source.url,error:run.error || '仓库导入仍有失败项；可在导入管理重试'});
      if (run.source_relations?.upstream_changes) errors.push({subscription_id:source.id,url:source.url,
        error:`仓库有 ${run.source_relations.upstream_changes} 篇修订，已保留本地正文与映射，等待核对`});
      results.push(resultRow(source,head.sha,run,run.reused_verified_run ? {reused_verified_run:true} : {}));
    } catch(error) {
      errors.push({subscription_id:source.id,url:source.url,error:error.message});
    }
  }
  return {results,errors};
}
