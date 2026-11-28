import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { digest, readJson, withLock } from './config.mjs';
import { discoverZhihuColumn } from '../scripts/zhihu-column-import.mjs';
import { zhihuColumnIdentity } from '../scripts/import-rule-catalog.mjs';
import { dataPath } from '../scripts/runtime-paths.mjs';

const schema = 'progressive-reading.zhihu-discovery/v1';
const host = 'mac-mini-tailscale';
const accountEndpoint = 'https://www.zhihu.com/api/v4/me';
const columnOrigin = 'https://zhuanlan.zhihu.com';
const maxBytes = 4 * 1024 * 1024;
const macDeadline = 95000;
const execute = promisify(execFile);
const hash = value => digest(JSON.stringify(value));
const nativeFailure = code => new Error('zhihu_remote_' + code);
const fail = code => { throw nativeFailure(code); };
const safeCode = error => /^zhihu_remote_[a-z_]+$/u.test(error?.message) ? error.message : 'zhihu_remote_unavailable';
const isSource = url => {
  if (typeof url !== 'string' || url.length > 1024) return false;
  try { return Boolean(zhihuColumnIdentity(url)); } catch { return false; }
};

function validateRequest(request) {
  if (request?.schema !== schema || !/^scheduled-\d{4}-\d{2}-\d{2}$/u.test(request.cycle || '') ||
    !Number.isSafeInteger(request.revision) || request.revision < 0 || !Array.isArray(request.sources) ||
    !request.sources.length || request.sources.length > 30 || !request.sources.every(isSource) ||
    new Set(request.sources).size !== request.sources.length) fail('invalid_request');
}

function validatePages(pages) {
  if (!Array.isArray(pages) || !pages.length || pages.length > 1000) fail('incomplete_pages');
  let expectedOffset = 0;
  for (const [index, page] of pages.entries()) {
    const last = index === pages.length - 1;
    if (page?.offset !== expectedOffset || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100 ||
        !Number.isSafeInteger(page.rows) || page.rows < 0 || page.rows > page.limit ||
        (page.total !== null && (!Number.isSafeInteger(page.total) || page.total < 0)) ||
        page.end !== last || (!last && page.rows === 0)) fail('incomplete_pages');
    expectedOffset += page.limit;
  }
}

function validMaterial(item) {
  const article = /^https:\/\/zhuanlan\.zhihu\.com\/p\/(\d+)$/u.exec(item?.url);
  const answer = /^https:\/\/www\.zhihu\.com\/question\/\d+\/answer\/(\d+)$/u.exec(item?.url);
  const expectedKey = article ? 'zhihu:articles:' + article[1] : answer ? 'zhihu:answers:' + answer[1] : null;
  return expectedKey && item.key === expectedKey && typeof item.title === 'string' &&
    (item.author === undefined || typeof item.author === 'string') &&
    (item.published_at === null || typeof item.published_at === 'string' && !Number.isNaN(Date.parse(item.published_at))) &&
    typeof item.revision === 'string' && Object.keys(item).every(key=>['key','url','title','author','published_at','revision'].includes(key));
}

function validateColumn(column, url) {
  if (column?.source_url !== url || column.column_id !== zhihuColumnIdentity(url).id ||
    !Number.isSafeInteger(column.listed_items) || column.listed_items < 0 ||
    !Number.isSafeInteger(column.pinned_items) || column.pinned_items < 0 ||
    !Array.isArray(column.materials) || !column.materials.every(validMaterial) ||
    new Set(column.materials.map(item=>item.key)).size !== column.materials.length ||
    !Array.isArray(column.warnings) || column.complete !== (column.warnings.length === 0)) fail('invalid_column');
  validatePages(column.pages);
  const totals = [...new Set(column.pages.map(page=>page.total).filter(total=>total!==null))];
  const expectedTotal = column.pages.findLast(page=>page.total!==null)?.total ?? null;
  const countWarning = expectedTotal !== null && (column.listed_items !== expectedTotal || totals.length > 1);
  if (column.warnings.length !== Number(countWarning)) fail('invalid_warning');
  if (column.listed_items > column.pages.reduce((sum,page)=>sum+page.rows,0) ||
    column.materials.length > column.listed_items + column.pinned_items) fail('invalid_column');
  for (const warning of column.warnings) {
    if (warning.code !== 'zhihu_column_count_discrepancy' || warning.severity !== 'warning' || warning.inventory_complete !== false ||
      warning.actual_count !== column.listed_items || warning.platform_total !== expectedTotal ||
      JSON.stringify(warning.observed_totals) !== JSON.stringify(totals)) fail('invalid_warning');
  }
}

async function collectColumn(url, readChromeJson) {
  const endpoint = '/api/columns/' + zhihuColumnIdentity(url).id;
  const pages = [];
  let offset = 0;
  const column = await discoverZhihuColumn(url, { strictCounts:false, includeAnswers:true,
    requestJson: async href => {
      const target = new URL(href);
      if (target.origin !== columnOrigin || target.hash || target.username || target.password) fail('invalid_endpoint');
      if (target.pathname === endpoint+'/pinned-items/v2' && !target.search) return readChromeJson(href);
      const limit = Number(target.searchParams.get('limit'));
      if (target.pathname !== endpoint+'/items' || [...target.searchParams.keys()].sort().join(',') !== 'limit,offset' ||
        target.searchParams.get('offset') !== String(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('incomplete_pages');
      const payload = await readChromeJson(href);
      if (!Array.isArray(payload.data) || typeof payload.paging?.is_end !== 'boolean') fail('incomplete_pages');
      pages.push({offset,limit,rows:payload.data.length,end:payload.paging.is_end,
        total:payload.paging.totals==null ? null : Number(payload.paging.totals)});
      offset += limit;
      return payload;
    }});
  const result = { source_url:url, column_id:column.column_id, complete:column.complete, listed_items:column.listed_items,
    pinned_items:column.pinned_items,pages,warnings:column.warnings || [],
    materials:column.materials.map(({key,url,title,author,published_at,revision})=>({key,url,title,author,published_at,revision})) };
  validateColumn(result,url);
  return result;
}

export async function generateZhihuDiscovery(request, readChromeJson) {
  validateRequest(request);
  const account = await readChromeJson(accountEndpoint);
  if (!account || account.is_anonymous === true || account.error || !/^[A-Za-z0-9_-]{2,128}$/u.test(String(account.id || '')))
    fail('native_session_unavailable');
  const columns = [];
  for (const url of request.sources) columns.push(await collectColumn(url,readChromeJson));
  return {schema,requestSha256:hash(request),resultSha256:hash(columns),columns};
}

export function verifyZhihuDiscovery(request, result) {
  validateRequest(request);
  const columns = result?.columns;
  if (result?.schema !== schema || result.requestSha256 !== hash(request) || !Array.isArray(columns) ||
    columns.length !== request.sources.length || result.resultSha256 !== hash(columns)) fail('receipt_mismatch');
  return new Map(columns.map((column,index)=>{
    const url=request.sources[index];
    validateColumn(column,url);
    return [url,column];
  }));
}

async function requestMac(binding, request) {
  const remote = binding.home + '/Agent/Projects/progressive-reading-workflow/subscription-workflow/zhihu-discovery-stage.mjs';
  const command = 'exec /usr/bin/env PROGRESSIVE_READING_DATA_HOME=' + binding.home + '/Agent/AppData ' +
    binding.home + '/.local/bin/node ' + remote;
  return new Promise((resolve,reject)=>{
    const child=execFile('ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no',
      '-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','ConnectTimeout=4',host,command],
      {windowsHide:true,timeout:macDeadline+8000,maxBuffer:maxBytes},(error,stdout,stderr)=>{
        if (error) return reject(new Error(safeCode({message:stderr?.trim()})));
        try { resolve(JSON.parse(stdout)); } catch { reject(nativeFailure('invalid_response')); }
      });
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(request));
  });
}

export async function boundZhihuDiscovery(home, cycle, revision, sources, { send = requestMac } = {}) {
  if (!/^scheduled-\d{4}-\d{2}-\d{2}$/u.test(cycle) || !sources.length) return null;
  try {
    const binding = await readJson(path.join(home,'remote-zhihu-discovery.json'));
    if (binding?.enabled !== true) return null;
    if (binding.host !== host || !/^\/Users\/[A-Za-z0-9_-]+$/u.test(binding.home || '')) fail('invalid_binding');
    const request = {schema,cycle,revision,sources:sources.map(source=>source.url)};
    validateRequest(request);
    const result = await send(binding,request);
    const columns = verifyZhihuDiscovery(request,result);
    return {columns,receipt:{executor:'mac',cycle,sourceCount:columns.size,
      requestSha256:result.requestSha256,resultSha256:result.resultSha256}};
  } catch(error) {
    return {columns:null,receipt:{executor:'windows',cycle,fallback:safeCode(error)}};
  }
}

async function readChromeFactory() {
  const home = dataPath('ProgressiveReading','ZhihuDiscovery');
  await fs.mkdir(home,{recursive:true,mode:0o700});
  const started = Date.now();
  return async url => {
    if (Date.now()-started > macDeadline-26000) fail('deadline');
    const scratch = await fs.mkdtemp(path.join(home,'tab-'));
    const output = path.join(scratch,'response.html');
    try {
      await execute('/usr/bin/osascript',[path.join(import.meta.dirname,'zhihu-chrome-tab.applescript'),url,output],
        {timeout:26000,maxBuffer:8192});
      if ((await fs.stat(output)).size > maxBytes) fail('response_too_large');
      return JSON.parse(await fs.readFile(output,'utf8'),(key,value,context)=>
        typeof value==='number' && !Number.isSafeInteger(value) && /^-?\d+$/u.test(context?.source || '') ? context.source : value);
    } finally {
      await fs.unlink(output).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await fs.rmdir(scratch);
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.platform !== 'darwin') fail('mac_required');
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 64*1024) fail('request_too_large');
    }
    const request = JSON.parse(input.replace(/^\uFEFF/u,''));
    const readChromeJson = await readChromeFactory();
    const result = await withLock(path.join(dataPath('ProgressiveReading','ZhihuDiscovery'),'chrome.lock'),
      ()=>generateZhihuDiscovery(request,readChromeJson));
    console.log(JSON.stringify(result));
  } catch(error) {
    console.error(safeCode(error));
    process.exitCode = 1;
  }
}
