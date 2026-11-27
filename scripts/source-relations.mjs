import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,withLock,digest} from '../subscription-workflow/config.mjs';
import {findSourcePublications} from './reading-source-library.mjs';
import {urlImportDedupeKey} from './url-import-input.mjs';

export const relationsPath=root=>path.join(root,'.local-ir','source-relations.json');
export async function bindRepositoryRelations(root, captures, publications) {
  const file=relationsPath(root),published=new Map(publications.filter(row=>row.verified).map(row=>[row.url,row]));
  const candidates=captures.filter(item=>item.metadata?.original_link_evidence?.status==='verified'&&published.has(item.url));
  const originals=await findSourcePublications(root,candidates.map(c=>c.metadata.original_url));
  return withLock(file+'.lock',async()=>{
    const registry=await readJson(file) || {schema:'progressive-reading.source-relations/v1',representations:{}};
    let upstreamChanges=0;
    for(const capture of candidates){
      const metadata=capture.metadata,row=published.get(capture.url),original=originals.get(urlImportDedupeKey(metadata.original_url));
      const key=urlImportDedupeKey(capture.url),previous=registry.representations[key];
      if(previous&&previous.source_sha256!==capture.source_response.sha256&&previous.translation_sha256===row.sha256){
        registry.representations[key]={...previous,revision_status:'review_required',upstream_revision:{repository:metadata.repository,source_sha256:capture.source_response.sha256,evidence:metadata.original_link_evidence}};
        upstreamChanges++;continue;
      }
      registry.representations[key]={fact_source_url:urlImportDedupeKey(metadata.original_url),original_url:metadata.original_url,translation_url:capture.url,
        translation_path:row.path,translation_sha256:row.sha256,original_path:original?.path||null,original_sha256:original?.sha256||null,
        repository:metadata.repository,evidence:metadata.original_link_evidence,source_sha256:capture.source_response.sha256};
    }
    registry.updated_at=new Date().toISOString();await writeJson(file,registry);
    return {registry:file,verified_relations:candidates.length,bound_local_files:candidates.filter(c=>originals.has(urlImportDedupeKey(c.metadata.original_url))).length,upstream_changes:upstreamChanges};
  });
}
export async function resolveSourceRelation(root, url) {
  const key=urlImportDedupeKey(url),registry=await readJson(relationsPath(root));
  const direct=registry?.representations?.[key];
  const fact=direct?.fact_source_url || key;
  const rows=Object.values(registry?.representations || {}).filter(row=>row.fact_source_url===fact);
  if(!rows.length)return null;
  const originals=await findSourcePublications(root,[rows[0].original_url,...rows.map(row=>row.translation_url)]);
  const original=originals.get(urlImportDedupeKey(rows[0].original_url));
  const translations=[];
  for(const row of rows){
    const translationPath=originals.get(urlImportDedupeKey(row.translation_url))?.path || row.translation_path;
    const bytes=await fs.readFile(translationPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    translations.push({...row,translation_path:translationPath,original_path:original?.path||null,original_sha256:original?.sha256||null,translation_exists:!!bytes,translation_changed:!!bytes&&digest(bytes)!==row.translation_sha256});
  }
  return {fact_source_url:fact,original_url:rows[0].original_url,original:original || null,translations,original_fetch_required:!original};
}
