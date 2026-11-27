import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreprocessingRequest, validateResultContract, writeRunArtifacts } from '../index.mjs';

const schema = 'progressive-reading.browser-preprocess-ssh/v1';
const requestLimit = 16 * 1024 * 1024;
const responseLimit = 64 * 1024 * 1024;
const fingerprint = data => createHash('sha256').update(data).digest('hex');

function remoteError(code) {
  const error = new Error(`浏览器正文加工的远端阶段未完成（${code}）`);
  error.code = code;
  return error;
}

function containsMachineData(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    /^(?:raw_?html|html_?snapshot|html|dom|cookies?|cookie_?header|headers|authorization|credentials?|api_?key|password|storage_?state|access_?token|refresh_?token|annotations|selection|qa_?cards)$/iu.test(key) ||
    containsMachineData(child));
}

export async function runBrowserPreprocessOverSsh(request, { host, outputDir, onProgress } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/u.test(host)) throw remoteError('browser_preprocess_ssh_invalid_host');
  if (containsMachineData(request.source_metadata)) throw remoteError('browser_preprocess_ssh_nonportable_metadata');
  const envelope = JSON.stringify({ schema, request });
  if (Buffer.byteLength(envelope) > requestLimit) throw remoteError('browser_preprocess_ssh_request_too_large');
  const requestHash = fingerprint(envelope);
  const run = await new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', host,
      'exec node "$HOME/Agent/Projects/progressive-reading-workflow/standard-preprocessing/integrations/browser-preprocess-ssh.mjs"'],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let settled = false;
    let bytes = 0;
    let buffer = '';
    let result;
    let progress = Promise.resolve();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); }
      else resolve(value);
    };
    const timer = setTimeout(() => finish(remoteError('browser_preprocess_ssh_timeout')), 45 * 60 * 1000);
    child.on('error', () => finish(remoteError('browser_preprocess_ssh_unavailable')));
    child.stdin.on('error', () => {}); // SSH exit code supplies the transport status.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > responseLimit) return finish(remoteError('browser_preprocess_ssh_response_too_large'));
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event;
        try { event = JSON.parse(line); } catch { return finish(remoteError('browser_preprocess_ssh_invalid_response')); }
        if (!event || event.schema !== schema || event.requestHash !== requestHash || result) return finish(remoteError('browser_preprocess_ssh_invalid_response'));
        if (event.type === 'progress' && typeof event.stage === 'string') {
          progress = progress.then(() => onProgress?.({ stage: event.stage }));
          progress.catch(() => finish(remoteError('browser_preprocess_ssh_progress_failed')));
        } else if (event.type === 'result' && event.run?.result) {
          result = event.run;
        } else {
          return finish(remoteError(event.type === 'error' ? 'browser_preprocess_ssh_worker_failed' : 'browser_preprocess_ssh_invalid_response'));
        }
      }
    });
    child.on('close', code => {
      if (code === 255) return finish(remoteError('browser_preprocess_ssh_unavailable'));
      if (code !== 0 || buffer.trim() || !result) return finish(remoteError('browser_preprocess_ssh_missing_result'));
      progress.then(() => finish(null, result), () => finish(remoteError('browser_preprocess_ssh_progress_failed')));
    });
    child.stdin.end(envelope);
  });
  const validation = await validateResultContract(run.result);
  if (!validation.valid) throw remoteError('browser_preprocess_ssh_result_contract');
  const written = outputDir ? await writeRunArtifacts(request, run.result, outputDir) : { output_dir: null, files: {} };
  return { ...run, result_validation: validation, ...written };
}

async function worker() {
  try {
    const input = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > requestLimit) throw new Error('request_too_large');
      input.push(chunk);
    }
    const contents = Buffer.concat(input);
    const requestHash = fingerprint(contents);
    const send = event => process.stdout.write(`${JSON.stringify({ schema, requestHash, ...event })}\n`);
    try {
      const envelope = JSON.parse(contents.toString('utf8'));
      if (envelope?.schema !== schema || envelope.request?.source_type !== 'browser_capture_markdown') throw new Error('invalid_request');
      const root = path.join(homedir(), 'Agent');
      const cache = path.join(root, 'Caches', 'ProgressiveReading');
      if (process.platform === 'darwin') {
        process.env.PR_TRANSLATION_PROMPT_PATH ||= path.join(root, 'AppData', 'ProgressiveReading', 'TranslationPrompts', 'general-translation.txt');
        process.env.AI_PRODUCER_CODEX_WORK_DIR ||= path.join(cache, 'codex-exec');
        process.env.PR_AUDIO_PYTHON ||= 'python3';
      }
      const run = await runPreprocessingRequest(envelope.request, {
        cacheDir: path.join(cache, 'preprocess'),
        onProgress: ({ stage }) => send({ type: 'progress', stage })
      });
      send({ type: 'result', run });
    } catch {
      send({ type: 'error' });
      process.exitCode = 1;
    }
  } catch {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await worker();
