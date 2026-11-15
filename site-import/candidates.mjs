import path from 'node:path';
import {sitePaths,now} from './store.mjs';
import {readJson,writeJson,withLock,canonicalUrl,digest} from '../subscription-workflow/config.mjs';
import {urlImportDedupeKey} from '../scripts/url-import-input.mjs';

const file=root=>path.join(sitePaths(root).home,'import-candidates.json');
export async function readCandidates(root){const state=await readJson(file(root))||{schema:'progressive-reading.import-candidates/v1',revision:0,items:[]};for(const item of state.items)item.import_reason??='';return state;}
export async function candidatePage(root,{status='pending',query='',page=0}={}){
 if(!['all','pending','dismissed'].includes(status))throw Error('候选状态无效');
 query=String(query).trim().toLocaleLowerCase();page=Number(page);if(!Number.isSafeInteger(page)||page<0)throw Error('页码无效');
 const state=await readCandidates(root),items=state.items.filter(item=>(status==='all'||item.status===status)&&(!query||[item.title,item.author,item.description,item.recommendation,item.import_reason,...item.sources.map(source=>source.heading+' '+source.source_url)].join(' ').toLocaleLowerCase().includes(query)));
 const pages=Math.max(1,Math.ceil(items.length/50));page=Math.min(page,pages-1);
 return {revision:state.revision,total:items.length,page,pages,items:items.slice(page*50,(page+1)*50)};
}
export async function registerCandidates(root,resources,{source_id,run_id}={}){
 return withLock(file(root)+'.lock',async()=>{
  const state=await readCandidates(root);let changed=false;
  for(const resource of resources){
   if(resource.kind!=='book'||!resource.title||!resource.evidence?.source_url)throw Error('书籍候选缺少来源证据');
   const url=canonicalUrl(resource.url),identity=urlImportDedupeKey(url),id='candidate-'+digest(identity).slice(0,24);
   let item=state.items.find(row=>row.id===id);
   if(!item){item={id,kind:'book',url,title:resource.title,author:resource.author||'',import_reason:'',status:'pending',reason:resource.reason,created_at:now(),sources:[]};state.items.push(item);changed=true;}
   for(const key of ['description','recommendation'])if(resource[key]&&!item[key]?.includes(resource[key])){item[key]=[item[key],resource[key]].filter(Boolean).join('\n\n');changed=true;}
   const source={source_id,run_id,...resource.evidence};
   // Runs are provenance, not a reason to duplicate the book or its origin.
   if(!item.sources.some(row=>row.source_id===source_id&&row.source_url===source.source_url&&row.heading===source.heading)){item.sources.push(source);changed=true;}
  }
  if(changed){state.revision++;await writeJson(file(root),state);}return state;
 });
}
export async function updateCandidate(root,{id,status,import_reason,revision}){
 if(status!==undefined&&!['pending','dismissed'].includes(status))throw Error('候选状态无效');
 if(import_reason!==undefined&&(typeof import_reason!=='string'||import_reason.length>6000))throw Error('导入理由最多 6000 字');
 return withLock(file(root)+'.lock',async()=>{
  const state=await readCandidates(root);if(state.revision!==revision)throw Error('清单已更新，请刷新后重试');
  const item=state.items.find(row=>row.id===id);if(!item)throw Error('候选不存在');
  if(status!==undefined)item.status=status;if(import_reason!==undefined)item.import_reason=import_reason;
  item.updated_at=now();state.revision++;await writeJson(file(root),state);return {revision:state.revision,item};
 });
}
export const setCandidateStatus=updateCandidate;
