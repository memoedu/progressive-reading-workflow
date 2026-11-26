import fs from 'node:fs/promises';
import path from 'node:path';
import { assertLocalRequest } from '../subscription-workflow/http.mjs';
import { readSources, saveSiteSource, listRuns, readRun, CODE_ROOT } from './store.mjs';
import { siteRunStatus,startSiteRun } from './tasks.mjs';
import {resolveSourceRelation} from '../scripts/source-relations.mjs';
import {candidatePage,updateCandidate} from './candidates.mjs';
import {INTERACTIVE_IMPORT_SOURCES} from '../scripts/browser-import-broker.mjs';
import { readingPublicationReceipt } from '../subscription-workflow/reading-publication-outbox.mjs';

const assets=new Map([['/imports',['index.html','text/html']],['/imports/',['index.html','text/html']],['/imports/app.mjs',['app.mjs','text/javascript']],['/imports/style.css',['style.css','text/css']],['/import-candidates',['candidates.html','text/html']],['/import-candidates/',['candidates.html','text/html']],['/import-candidates/app.mjs',['candidates.mjs','text/javascript']]]);
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
function brief(run){if(!run)return null;const {collection,results,...rest}=run;return {...rest,result_count:results?.length||0,index:collection?.verification?.index||null,excluded_count:collection?.inventory?.excluded_count||0,error:collection?.error||null};}
export async function handleImportCenter(req,res,{root,broker,runRequest,legacyJobs=()=>[]}={}) {
  const url=new URL(req.url,'http://127.0.0.1');
  if(!assets.has(url.pathname)&&!url.pathname.startsWith('/api/site-imports')&&!url.pathname.startsWith('/api/import-center')&&!url.pathname.startsWith('/api/import-candidates')&&url.pathname!=='/api/source-relations')return false;
  try{
    assertLocalRequest(req);
    if(req.method==='GET'&&url.pathname==='/api/import-candidates'){send(res,200,await candidatePage(root,{status:url.searchParams.get('status')||'pending',query:url.searchParams.get('q')||'',page:url.searchParams.get('page')||0}));return true;}
    if(req.method==='GET'&&url.pathname==='/api/source-relations'){send(res,200,await resolveSourceRelation(root,url.searchParams.get('url')));return true;}
    if(assets.has(url.pathname)&&req.method==='GET'){
      const [file,type]=assets.get(url.pathname),content=await fs.readFile(path.join(CODE_ROOT,'site-import','web',file));
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
        'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(content);return true;
    }
    if(req.method==='GET'&&url.pathname==='/api/site-imports'){
      const config=await readSources(root),runs=await Promise.all((await listRuns(root)).map(run=>siteRunStatus(run,broker)));
      send(res,200,{...config,capabilities:{infer_topics:true,compact_run_detail:true},sources:config.sources.map(source=>({...source,last_run:brief(runs.find(run=>run.source_id===source.id))})),runs:runs.slice(0,30).map(brief)});return true;
    }
    if(req.method==='GET'&&url.pathname==='/api/import-center/history'){
      send(res,200,{requests:await broker.listRequestSummaries({sources:INTERACTIVE_IMPORT_SOURCES}),legacy_jobs:legacyJobs()});return true;
    }
    const sharedPublication = /^\/api\/import-center\/shared-publications\/([a-f0-9]{64})$/u.exec(url.pathname);
    if (req.method === 'GET' && sharedPublication) {
      const receipt = await readingPublicationReceipt(root, sharedPublication[1]);
      send(res, receipt ? 200 : 404, receipt || {error:'shared_publication_receipt_not_found'});
      return true;
    }
    if(req.method==='GET'&&url.pathname==='/api/import-center/maintenance-failures'){
      const since=Date.parse(url.searchParams.get('since'));
      if(!Number.isFinite(since))throw new Error('invalid_maintenance_start_time');
      send(res,200,{failures:await broker.listMaintenanceFailures(since)});return true;
    }
    const detail=/^\/api\/site-imports\/runs\/(site-run-[a-f0-9]{24})$/u.exec(url.pathname);
    if(req.method==='GET'&&detail){const run=await siteRunStatus(await readRun(root,detail[1]),broker);let value=run;
      if(run&&url.searchParams.get('view')==='compact'){const {results,...collection}=run.collection||{};value={...run,detail_view:'compact',...(run.collection?{collection}: {})};}
      send(res,run?200:404,value || {error:'导入记录不存在'});return true;}
    if(req.method!=='POST'){send(res,405,{error:'此操作不支持该请求方法'});return true;}
    if(!/^application\/json(?:;|$)/iu.test(req.headers['content-type']||''))throw new Error('需要 JSON 请求');
    let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>100000)throw new Error('请求过大');}
    const input=JSON.parse(text||'{}');
    if(['/api/import-candidates/status','/api/import-candidates/update'].includes(url.pathname))send(res,200,await updateCandidate(root,input));
    else if(url.pathname==='/api/site-imports/source')send(res,200,await saveSiteSource(root,input.source,input.revision));
    else if(url.pathname==='/api/site-imports/start')send(res,202,brief(await startSiteRun(root,input,broker,runRequest)));
    else if(url.pathname==='/api/site-imports/pause'){
      if(!/^browser-import-task-[a-f0-9-]{36}$/u.test(input.task_id||''))throw new Error('invalid_import_task_id');
      send(res,200,await broker.pauseSiteTask(input.task_id,input.expected_status));
    }
    else if(url.pathname==='/api/import-center/maintenance-retry'){
      const request = await broker.retryMaintenanceTask(input.task_id, async (site, clientRequestId, taskId) => {
        const previous = await readRun(root, site.run_id);
        if (!previous) throw new Error('original_site_run_missing');
        const next = await startSiteRun(root, {source_id: previous.source_id, retry_run_id: site.run_id, client_request_id: clientRequestId},
          broker, runRequest, {maintenanceRetryOf: taskId});
        return broker.getRequest(next.request_id);
      });
      void runRequest(request.request_id).catch(() => {});
      send(res,202,{request_id:request.request_id,status:request.status});
    }
    else send(res,404,{error:'接口不存在'});
  }catch(error){send(res,400,{error:error.message});}
  return true;
}
