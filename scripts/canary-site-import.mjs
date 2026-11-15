// Runs the actual import-center form/controller without activating a user browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const args=process.argv.slice(2),value=(flag,fallback)=>args.includes(flag)?args[args.indexOf(flag)+1]:fallback;
const target=value('--url'),endpoint=value('--endpoint','http://127.0.0.1:37829'),mode=value('--mode','standard_preprocess'),subscribeRss=args.includes('--subscribe-rss');
if(!target)throw new Error('usage: node scripts/canary-site-import.mjs --url https://example.com [--name Name] [--output absolute.json]');
const fetchImpl=(route,options)=>fetch(endpoint+route,options);
const response=await fetchImpl('/imports');if(!response.ok)throw new Error('import_center_unavailable');
const dom=new JSDOM(await response.text(),{url:endpoint+'/imports'}),doc=dom.window.document;
const client=pathToFileURL(path.resolve(import.meta.dirname,'browser-import-web/client.mjs')).href;
const code=(await fs.readFile(new URL('../site-import/web/app.mjs',import.meta.url),'utf8')).replace("'/import/client.mjs'",JSON.stringify(client));
const {mountImportCenter}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const mounted=mountImportCenter(doc,{fetchImpl,pollMs:1000000});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pollMs=Number(value('--poll-ms','10000'));if(!Number.isSafeInteger(pollMs)||pollMs<2500||pollMs>60000)throw Error('invalid_canary_poll_interval');
async function state(){const deadline=Date.now()+180000;for(let attempt=0;;attempt++){try{const response=await fetchImpl('/api/site-imports',{signal:AbortSignal.timeout(30000)});if(!response.ok){const error=new Error('state_unavailable:'+response.status);error.terminal=[401,403].includes(response.status);throw error;}return await response.json();}catch(error){if(error.terminal||Date.now()>=deadline)throw error;if(attempt%10===0)console.log(JSON.stringify({connection:'waiting',error:error.message,read_only_retry:true}));await delay(Math.min(3000,500*(attempt+1)));}}}
try{
  await delay(100);await mounted.refresh();let data=await state();
  let source=data.sources.find(source=>new URL(source.url).href===new URL(target).href);
  if(!source || source.processing_mode!==mode || subscribeRss&&!source.subscribe_rss){
    mounted.editor(source);doc.getElementById('site-url').value=target;doc.getElementById('site-name').value=value('--name',source?.name||new URL(target).hostname);
    doc.getElementById('site-mode').value=mode;doc.getElementById('site-mode').dispatchEvent(new dom.window.Event('change'));
    if(subscribeRss)doc.getElementById('site-rss').checked=true;
    doc.getElementById('site-form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    const deadline=Date.now()+30000;
    while(!doc.getElementById('site-editor').hidden&&Date.now()<deadline){if(doc.getElementById('site-form-error').textContent)throw new Error(doc.getElementById('site-form-error').textContent);await delay(100);}
    if(!doc.getElementById('site-editor').hidden)throw new Error('save_form_timeout');
    data=await state();source=data.sources.find(s=>new URL(s.url).href===new URL(target).href);if(!source)throw new Error('source_not_saved');
  }
  const active=source.last_run&&!['completed','failed','completed_with_failures','needs_classification'].includes(source.last_run.phase);
  if(!active)await mounted.start(source,args.includes('--retry')&&source.last_run?source.last_run.id:null);
  let last='';const hours=Number(value('--timeout-hours','6'));if(!Number.isFinite(hours)||hours<=0||hours>24)throw Error('invalid_canary_timeout_hours');const deadline=Date.now()+hours*60*60*1000;let terminal=false;
  while(Date.now()<deadline){
    data=await state();const run=data.sources.find(s=>s.id===source.id).last_run;
    const summary=JSON.stringify({id:run.id,phase:run.phase,stage:run.stage,counts:run.counts,checked:run.discovery?.checked,total:run.discovery?.total,error:run.error});
    if(summary!==last){console.log(summary);last=summary;}
    if(['completed','failed','completed_with_failures','needs_classification'].includes(run.phase)){
      terminal=true;
      const detail=await (await fetchImpl('/api/site-imports/runs/'+run.id)).json();
      const output=value('--output');if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify({entry:'/imports',frontend_controller:true,run:detail},null,2));}
      await mounted.refresh();console.log(JSON.stringify({rendered_summary:doc.getElementById('site-sources').textContent,output}));
      if(run.phase!=='completed')process.exitCode=1;break;
    }
    await delay(pollMs);
  }
  if(!terminal&&Date.now()>=deadline)throw Error('site_canary_deadline_exceeded_no_completion_claimed');
}finally{mounted.stop();dom.window.close();}
