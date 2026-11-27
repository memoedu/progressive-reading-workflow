import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, paths, readJson } from './config.mjs';

const schema = 'progressive-reading.report-draft/v1';
const cap = 4 * 1024 * 1024;
const remotePath = '/Agent/Projects/progressive-reading-workflow/subscription-workflow/report-draft-transport.mjs';

export async function boundReportDraft(root, cycle) {
  if (!/^scheduled-\d{4}-\d{2}-\d{2}$/u.test(cycle)) return null;
  const binding = await readJson(path.join(paths(root).home, 'remote-report-render.json'));
  if (binding?.enabled !== true) return null;
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/u.test(binding.host || '') ||
      !/^\/Users\/[a-zA-Z0-9._-]+$/u.test(binding.home || '')) throw Error('report_draft_binding_invalid');
  const command = `${binding.home}/.local/bin/node ${binding.home}${remotePath}`;
  return input => renderOverSsh(binding.host, command, cycle, input);
}

function exchange(host, command, message) {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'ConnectTimeout=6', host, command],
      { windowsHide:true, timeout:25000, maxBuffer:cap }, (error, stdout) => {
        if (error) reject(Error('report_draft_remote_unavailable'));
        else resolve(stdout);
      });
    child.stdin.on('error', () => {});
    child.stdin.end(message);
  });
}

async function renderOverSsh(host, command, cycle, input) {
  const request = { schema, cycle, input };
  const wire = JSON.stringify(request);
  if (Buffer.byteLength(wire) > cap) throw Error('report_draft_input_too_large');
  const result = JSON.parse(await exchange(host, command, wire));
  const requestSha256 = digest(wire);
  if (result.schema !== schema || result.cycle !== cycle || result.requestSha256 !== requestSha256 ||
      result.resultSha256 !== digest(JSON.stringify(result.draft))) throw Error('report_draft_receipt_mismatch');
  return { draft:result.draft, receipt:{ executor:'mac', cycle, requestSha256, resultSha256:result.resultSha256 } };
}

async function main() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > cap) throw Error('report_draft_input_too_large');
    chunks.push(chunk);
  }
  const wire = Buffer.concat(chunks).toString('utf8');
  const request = JSON.parse(wire);
  if (request.schema !== schema || !/^scheduled-\d{4}-\d{2}-\d{2}$/u.test(request.cycle || '')) {
    throw Error('report_draft_request_invalid');
  }
  const { renderGeneratedReportDraft } = await import('../rss-reading/core.mjs');
  const draft = renderGeneratedReportDraft(request.input);
  const result = { schema, cycle:request.cycle, requestSha256:digest(wire), resultSha256:digest(JSON.stringify(draft)), draft };
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > cap) throw Error('report_draft_output_too_large');
  process.stdout.write(output + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
