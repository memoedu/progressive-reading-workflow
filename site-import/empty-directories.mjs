import fs from 'node:fs/promises';
import path from 'node:path';

// Remove only empty descendants. Never follow links, remove the source root,
// or delete a file; a concurrent new publication makes rmdir fail harmlessly.
export async function pruneEmptySiteDirectories(base){
 const root=path.resolve(base),removed=[];
 const realRoot=await fs.realpath(root).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(!realRoot)return removed;
 const visit=async directory=>{
  const stat=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!stat||stat.isSymbolicLink()||!stat.isDirectory())return;
  const real=await fs.realpath(directory),relative=path.relative(realRoot,real);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('空目录清理路径超出整站目录');
  const entries=await fs.readdir(directory,{withFileTypes:true});
  for(const entry of entries)if(entry.isDirectory()&&!entry.isSymbolicLink())await visit(path.join(directory,entry.name));
  if(directory===root)return;
  try{await fs.rmdir(directory);removed.push(directory);}
  catch(error){if(!['ENOTEMPTY','EEXIST','ENOENT'].includes(error.code))throw error;}
 };
 await visit(root);return removed;
}
