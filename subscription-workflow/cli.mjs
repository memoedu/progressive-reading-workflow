import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { codeRoot, initialize, paths, loadConfig, writeJson, withLock } from './config.mjs';
import { JOB_KINDS, enqueue, enqueueVideoRequest, launchWorker, drain, status, initializeActivity, localDate } from './service.mjs';
import { downloadSharedReading, downloadSharedVersion, resolveSharedMaterial, syncSharedReading } from './shared-library-client.mjs';
import { sharedDigest, sharedReadingSource } from './shared-library.mjs';

export async function main(argv=process.argv.slice(2)) {
  const command=argv[0],options={};
  for(let i=1;i<argv.length;i+=2)options[argv[i].replace(/^--/u,'')]=argv[i+1];
  const root=options.root?path.resolve(options.root):codeRoot;
  if(command==='publish-shared-reading') {
    if(!options.request||!options.markdown||!options.sha256)throw new Error('需要 --request、--markdown 和 --sha256');
    const request=JSON.parse(await fs.readFile(options.request,'utf8'));
    const bytes=await fs.readFile(options.markdown);
    if(sharedDigest(bytes)!==options.sha256||request.user_instruction?.trim()||typeof request.material?.markdown!=='string') {
      throw new Error('shared_publication_source_or_hash_mismatch');
    }
    const url=request.source_metadata?.source_url;
    const kind=sharedReadingSource(url)==='bilibili'?'bilibili':'web';
    return syncSharedReading(root,{url,kind,original:request.material.markdown,markdown:bytes.toString('utf8'),processingOptions:request.processing_options});
  }
  if(command==='download-shared-reading') {
    if(!options.output)throw new Error('需要 --output 指定新文件位置');
    const processingOptions=options.options?JSON.parse(await fs.readFile(options.options,'utf8')):{};
    const kind=sharedReadingSource(options.url)==='bilibili'?'bilibili':'web';
    const result=await downloadSharedReading(root,{url:options.url,kind,processingOptions});
    if(!result)return {status:'unavailable'};
    const {readingBytes,originalBytes,...receipt}=result;
    await fs.writeFile(options.output,readingBytes,{flag:'wx'});
    return {...receipt,output:path.resolve(options.output)};
  }
  if(command==='download-shared-version'||command==='sync-shared-material') {
    if (!options.output) throw new Error('需要 --output 指定新文件位置');
    const result=command==='download-shared-version'
      ? await downloadSharedVersion(root,{url:options.url,kind:options.kind,sha256:options.sha256})
      : await resolveSharedMaterial(root,options.sha256,{lookupOnly:options['lookup-only']==='true'});
    if (!result) return {status:'unavailable'};
    const {bytes,...receipt}=result;
    if (!bytes) return receipt;
    const output=path.resolve(options.output);
    await fs.writeFile(output,bytes,{flag:'wx'});
    return {...receipt,output};
  }
  if(command==='init') {const config=await initialize(root);await initializeActivity(root);return {status:'initialized',enabled:config.enabled,subscriptions:config.subscriptions.length};}
  if(command==='activate')return withLock(paths(root).config+'.lock',async()=>{const config=await loadConfig(root);if(!config)throw new Error('请先初始化');await initializeActivity(root);config.enabled=true;config.revision++;await writeJson(paths(root).config,config);return {status:'active'};});
  if(command==='status')return status(root);
  if(command==='drain')return drain(root);
  if(command==='run-scheduled-rss' || command==='run-scheduled-report') {
    const kind = command==='run-scheduled-rss' ? 'rss' : options.kind;
    if (!['rss','daily','weekly'].includes(kind) || !/^scheduled-\d{4}-\d{2}-\d{2}$/u.test(options.key || '')) {
      throw new Error('Invalid scheduled subscription period');
    }
    return drain(root, {kind, cycle:options.key});
  }
  if(command==='import-video') {
    if (!(await loadConfig(root))?.enabled) throw new Error('后台队列已暂停');
    const parts=options.parts ? options.parts.split(',').map(Number) : undefined;
    const job=await enqueueVideoRequest(root,{url:options.url,parts,destination:options.destination,
      output_type:options['output-type']},{retry:options.retry==='true'});
    await launchWorker(root);
    return {id:job.id,status:job.status,request:job.request};
  }
  if(command==='run'||command==='enqueue') {
    if(!JOB_KINDS.includes(options.kind))throw new Error('需要 --kind rss|bilibili|zhihu|daily|weekly|decisions|retry');
    const job=await enqueue(root,options.kind,options.key||localDate());
    if(command==='enqueue')return {id:job.id,status:job.status};
    const result=await drain(root);return {job:job.id,...result};
  }
  throw new Error('用法：cli.mjs init|activate|status|drain|run --kind <来源或报告>');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(v=>console.log(JSON.stringify(v,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
