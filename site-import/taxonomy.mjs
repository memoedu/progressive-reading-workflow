import path from 'node:path';
import sanitizeFilename from 'sanitize-filename';
import {digest} from '../subscription-workflow/config.mjs';

export const TAXONOMY_VERSION='source-taxonomy/v1';
// Whitespace-separated terminal bullets/arrows are presentation separators.
// Preserve punctuation within names (including C++, A · B and C#).
export const taxonomyLabel=value=>String(value||'').replace(/\s+/gu,' ').trim().replace(/\s+[•·|›»]+$/u,'').trim();
export function mergeTaxonomies(...taxonomies){
  const groups=[...new Map(taxonomies.flatMap(value=>value?.groups||[]).map(group=>[group.kind+'/'+group.path.join('/'),group])).values()];
  const rank={'合集':0,'分类':1,'标签':2};groups.sort((a,b)=>rank[a.kind]-rank[b.kind]);
  return {version:TAXONOMY_VERSION,groups,primary:groups[0]||{kind:'未分类',name:'未分类',path:[]}};
}
export function classifyExclusiveTags(articles){
  const explicitHierarchy=articles.some(article=>article.taxonomy.groups.some(group=>['合集','分类'].includes(group.kind)));
  const tagged=articles.filter(article=>article.taxonomy.groups.some(group=>group.kind==='标签'));
  const exclusive=!explicitHierarchy&&tagged.length>0&&articles.every(article=>article.taxonomy.groups.filter(group=>group.kind==='标签').length<=1);
  if(exclusive)for(const article of articles){
    const groups=article.taxonomy.groups.map(group=>group.kind==='标签'?{...group,kind:'分类',source_kind:'标签'}:group);
    article.taxonomy={...article.taxonomy,groups,primary:groups[0]||article.taxonomy.primary};
  }
  return {version:'site-tag-classification/v1',exclusive,tagged_articles:tagged.length,articles:articles.length,reason:explicitHierarchy?'已有原站合集或分类':exclusive?'完整核验范围中每篇至多一个原站标签，作为分类':tagged.length?'标签存在多重归属，保留标签关系':'未发现原站标签'};
}

export function linkedTaxonomy(container,base,{articleUrl}={}){
  const tags=[],categories=[],evidence=[];
  for(const anchor of container.querySelectorAll('a[href]')){
    let url;try{url=new URL(anchor.getAttribute('href'),base);if(url.origin!==new URL(base).origin||url.href===articleUrl)continue;}catch{continue;}
    const match=/(?:^|\/)(tags?|categor(?:y|ies))\/[^/]+/iu.exec(url.pathname),rel=anchor.rel.split(/\s+/u);
    const kind=rel.includes('category')||match&&/^categor/iu.test(match[1])?'分类':rel.includes('tag')||match?'标签':null;
    const name=taxonomyLabel(anchor.textContent);if(!kind||!name||name.length>160)continue;
    (kind==='分类'?categories:tags).push(name);evidence.push({kind,name,url:url.href});
  }
  return {taxonomy:articleTaxonomy({categories,tags}),evidence};
}
export function categorySegment(value){const raw=String(value).trim(),clean=sanitizeFilename(raw).trim().slice(0,100);return clean&&clean===raw?clean:(clean||'未命名')+'-'+digest(raw).slice(0,6);}
const names=value=>(Array.isArray(value)?value:value==null?[]:[value]).flatMap(item=>typeof item==='string'?[item]:item?.name?[item.name]:[]).filter(Boolean);
export function articleTaxonomy({collections=[],categories=[],tags=[]}={}){
  const groups=[...collections.map(item=>({kind:'合集',name:item.name,path:item.path||[item.name],order:item.order??null})),...(Array.isArray(categories)?categories:[categories]).filter(Boolean).map(item=>({kind:'分类',name:Array.isArray(item)?item.at(-1):item,path:Array.isArray(item)?item:[item]})),...names(tags).map(name=>({kind:'标签',name,path:[name]}))];
  const unique=[...new Map(groups.filter(g=>g.name&&g.path.every(p=>typeof p==='string'&&p.trim())).map(g=>[g.kind+'/'+g.path.join('/'),g])).values()];
  return {version:TAXONOMY_VERSION,groups:unique,primary:unique[0] || {kind:'未分类',name:'未分类',path:[]}};
}
export function taxonomyFromJson(json,mapping={},read,identity){
  const value=mapping.collection_path?read(json,mapping.collection_path):null;
  const collections=(Array.isArray(value)?value:value?[value]:[]).flatMap(collection=>{
    const name=typeof collection==='string'?collection:read(collection,mapping.collection_name_path||'name');if(!name)return [];
    const items=mapping.collection_items_path?read(collection,mapping.collection_items_path):collection?.items||collection?.articles||collection?.blogs||collection?.entries;
    const order=Array.isArray(items)?items.findIndex(item=>String(read(item,mapping.collection_item_identity_path||'id'))===String(identity)):null;
    return [{name,path:typeof collection==='object'&&Array.isArray(collection.path)?collection.path:[name],order:order>=0?order:null}];
  });
  return articleTaxonomy({collections,categories:mapping.categories_path?read(json,mapping.categories_path)||[]:[],tags:mapping.tags_path?read(json,mapping.tags_path)||[]:[]});
}
export function taxonomyFolder(destination,taxonomy){if(taxonomy?.repository_directory)return path.posix.join(destination,...taxonomy.repository_directory.map(categorySegment));const group=taxonomy?.primary || {kind:'未分类',path:[]};return path.posix.join(destination,group.kind,...group.path.map(categorySegment));}
export function taxonomyGroups(articles){
  const groups=new Map();for(const article of articles){const taxonomy=article.taxonomy || articleTaxonomy();for(const group of taxonomy.groups.length?taxonomy.groups:[taxonomy.primary]){const folder=path.posix.join(group.kind,...group.path.map(categorySegment)),key=folder.toLocaleLowerCase();if(!groups.has(key))groups.set(key,{...group,folder,articles:[]});groups.get(key).articles.push({...article,source_order:group.order});}}
  const rank={'合集':0,'分类':1,'标签':2,'未分类':3};
  return [...groups.values()].map(group=>({...group,articles:group.articles.sort((a,b)=>group.kind==='合集'?(a.source_order??1e9)-(b.source_order??1e9):0)})).sort((a,b)=>rank[a.kind]-rank[b.kind]||a.folder.localeCompare(b.folder,'zh-CN'));
}
