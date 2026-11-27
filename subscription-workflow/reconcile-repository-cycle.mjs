import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest,loadConfig,paths,readJson,withLock,writeJson} from './config.mjs';
import {readCompletedRepositoryCycle} from './repositories.mjs';

function findOnly(rows,predicate,error) {
  const matches=(rows || []).filter(predicate);
  if (matches.length!==1) throw Error(error);
  return matches[0];
}

export async function reconcileRepositoryCycle(root,scope,{apply=false,readEvidence=readCompletedRepositoryCycle}={}) {
  const p=paths(root);
  const id=digest('rss:'+scope.cycle).slice(0,32);
  const file=path.join(p.jobs,id+'.json');
  const summaryFile=path.join(p.home,'faults-rss.json');
  const action=async () => {
    const job=await readJson(file);
    if (job?.id!==id || job.kind!=='rss' || job.cycle!==scope.cycle || !job.steps?.scan?.done ||
        !['completed','completed_with_issues'].includes(job.status) || !job.completed_at) {
      throw Error('repository_original_rss_job_not_terminal');
    }
    const review=job.reconciliations?.repositories?.[scope.sourceId];
    let evidence;
    if (review) {
      if (review.adopted.commit!==scope.commit || review.adopted.run_id!==scope.completedRunId) {
        throw Error('repository_reconciliation_scope_conflict');
      }
      evidence=review;
    } else {
      const native=await readEvidence(root,scope);
      if ((await loadConfig(root))?.revision!==native.source_revision) throw Error('repository_registry_changed_during_readback');
      const scan=job.steps.scan.result;
      const repository=scan.repositories;
      const prior=findOnly(repository.results,row=>row.subscription_id===scope.sourceId && row.commit===scope.commit &&
        row.run_id===native.primary_run_id && ['failed','completed_with_failures'].includes(row.phase),
        'repository_original_result_mismatch');
      const matches=row=>row.subscription_id===scope.sourceId && row.url===native.source_url && row.error===native.original_error;
      const fault=findOnly(repository.errors,matches,'repository_original_scan_fault_mismatch');
      findOnly(scan.errors,matches,'repository_original_scan_summary_mismatch');
      findOnly(job.result.faults,matches,'repository_original_business_fault_mismatch');
      evidence={mode:'reused_verified_native_receipt',at:new Date().toISOString(),cycle:scope.cycle,job_id:id,
        cycle_request_id:native.cycle_request_id,cycle_native_run_id:native.cycle_native_run_id,site_id:native.site_id,
        verification:native.verification,native_completed_at:native.completed_at,
        previous:prior,resolved_fault:fault,adopted:native.result};
      if (apply) {
        repository.results=repository.results.map(row=>row===prior ? evidence.adopted : row);
        repository.errors=repository.errors.filter(row=>!matches(row));
        scan.errors=scan.errors.filter(row=>!matches(row));
        job.result.faults=job.result.faults.filter(row=>!matches(row));
        job.status=job.result.status=job.result.faults.length ? 'completed_with_issues' : 'completed';
        job.reconciliations ||= {};
        job.reconciliations.repositories ||= {};
        job.reconciliations.repositories[scope.sourceId]=evidence;
        await writeJson(file,job);
      }
    }

    // The job retains the original terminal time. Adjust only the summary
    // written by that same cycle, leaving any later run or alerts alone.
    const summary=await readJson(summaryFile);
    let summaryState='not_from_original_cycle';
    if (summary?.checked_at && Math.abs(Date.parse(job.completed_at)-Date.parse(summary.checked_at))<=10000) {
      const matches=row=>row.subscription_id===evidence.resolved_fault.subscription_id &&
        row.url===evidence.resolved_fault.url && row.error===evidence.resolved_fault.error;
      const faults=summary.faults.filter(row=>!matches(row));
      if (faults.length===summary.faults.length) summaryState='already_reconciled';
      else if (apply) {
        const signature=digest(JSON.stringify(faults.map(row=>String(row.error || row.reason || row)).sort()));
        await writeJson(summaryFile,{...summary,faults,signature,reconciled_at:evidence.at});
        summaryState='reconciled';
      } else summaryState='would_reconcile';
    }
    return {status:apply?(review?'already_reconciled':'reconciled'):(review?'already_reconciled':'verified'),
      summary:summaryState,...evidence};
  };
  return apply ? withLock(path.join(p.home,'worker.lock'),action) : action();
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [root,cycle,sourceId,commit,completedRunId,mode]=process.argv.slice(2);
  if (!root || !completedRunId || !['verify','apply'].includes(mode)) {
    throw Error('usage: reconcile-repository-cycle.mjs <project> <scheduled-cycle> <source-id> <commit> <verified-run-id> <verify|apply>');
  }
  const result=await reconcileRepositoryCycle(path.resolve(root),{cycle,sourceId,commit,completedRunId},{apply:mode==='apply'});
  console.log(JSON.stringify(result,null,2));
}
