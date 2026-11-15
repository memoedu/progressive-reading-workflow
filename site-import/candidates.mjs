import path from 'node:path';
import {sitePaths,now} from './store.mjs';
import {readJson,writeJson,withLock,canonicalUrl,digest} from '../subscription-workflow/config.mjs';
import {urlImportDedupeKey} from '../scripts/url-import-input.mjs';

const file=root=>path.join(sitePaths(root).home,'import-candidates.json');
export async function readCandidates(root){return await readJson(file(root))||{schema:'progressive-reading.import-candidates/v1',revision:0,items:[]};}
export async function registerCandidates(root,resources,{source_id,run_id}={}){
 return withLock(file(root)+'.lock',async()=>{
  const state=await readCandidates(root);let changed=false;
  for(const resource of resources){
   if(resource.kind!=='book'||!resource.title||!resource.evidence?.source_url)throw Error('书籍候选缺少来源证据');
   const url=canonicalUrl(resource.url),identity=urlImportDedupeKey(url),id='candidate-'+digest(identity).slice(0,24);
   let item=state.items.find(row=>row.id===id);
   if(!item){item={id,kind:'book',url,title:resource.title,author:resource.author||'',status:'pending',reason:resource.reason,created_at:now(),sources:[]};state.items.push(item);changed=true;}
   const source={source_id,run_id,...resource.evidence};
   // Runs are provenance, not a reason to duplicate the book or its origin.
   if(!item.sources.some(row=>row.source_id===source_id&&row.source_url===source.source_url&&row.heading===source.heading)){item.sources.push(source);changed=true;}
  }
  if(changed){state.revision++;await writeJson(file(root),state);}return state;
 });
}
export async function setCandidateStatus(root,{id,status,revision}){
 if(!['pending','dismissed'].includes(status))throw Error('候选状态无效');
 return withLock(file(root)+'.lock',async()=>{
  const state=await readCandidates(root);if(state.revision!==revision)throw Error('清单已更新，请刷新后重试');
  const item=state.items.find(row=>row.id===id);if(!item)throw Error('候选不存在');
  item.status=status;item.updated_at=now();state.revision++;await writeJson(file(root),state);return state;
 });
}
