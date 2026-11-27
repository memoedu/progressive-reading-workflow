import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, readJson, writeJson, withLock } from './config.mjs';

const schema = 'progressive-reading.subscription-report-candidate/v1';
const inputAreas = new Set(['workspace', 'state', 'rss', 'video']);

async function snapshot(home) {
  const entries = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(home, file).split(path.sep).join('/');
      if (!inputAreas.has(relative.split('/')[0])) continue;
      if (entry.name.startsWith('.') || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error('report_snapshot_unsupported_entry');
      }
      if (entry.isDirectory()) await visit(file);
      else entries.push([relative, digest(await fs.readFile(file))]);
    }
  }
  await visit(home);
  return digest(JSON.stringify({ origins: await readJson(path.join(home, 'roots.json')),
    files: entries.sort(([a], [b]) => a.localeCompare(b, 'en')) }));
}

function relocate(value, input, work, roots) {
  if (Array.isArray(value)) return value.map(child => relocate(child, input, work, roots));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, relocate(child, input, work, roots)]));
  }
  if (typeof value !== 'string') return value;
  if (value.startsWith(input + path.sep)) return work + value.slice(input.length);
  if (!/^[A-Z]:[\\/]/iu.test(value) || /[\r\n]/u.test(value)) return value;
  const slash = value.replaceAll('\\', '/');
  for (const [prefix, area] of roots) {
    if (slash !== prefix && !slash.startsWith(prefix + '/')) continue;
    const segments = slash.slice(prefix.length + 1).split('/');
    if (segments.some(part => part === '..' || part.startsWith('.'))) return value;
    return path.join(work, area, ...segments);
  }
  return value;
}

async function calculateReport(home, kind, cycle) {
  if (!path.isAbsolute(home) || !['daily','weekly'].includes(kind) || !/^scheduled-\d{4}-\d{2}-\d{2}$/u.test(cycle)) {
    throw new Error('report_candidate_identity_invalid');
  }
  const date = cycle.slice('scheduled-'.length);
  const folder = path.join(home, cycle, kind);
  const input = path.join(folder, 'input');
  const file = path.join(folder, 'receipt.json');
  return withLock(path.join(folder, 'calculate.lock'), async () => {
    const origins = await readJson(path.join(input, 'roots.json'));
    if (!origins || [...inputAreas].some(area => typeof origins[area] !== 'string' ||
      !path.win32.isAbsolute(origins[area]) || /[\r\n]/u.test(origins[area]))) throw new Error('report_candidate_origins_required');
    const roots = [...inputAreas].map(area => [origins[area].replaceAll('\\', '/').replace(/\/$/u, ''), area]);
    const inputSha = await snapshot(input);
    const saved = await readJson(file);
    if (saved) {
      if (saved.inputSha256 !== inputSha) throw new Error('report_candidate_cycle_input_conflict');
      for (const record of Object.values(saved.outputs)) {
        if (digest(await fs.readFile(path.join(folder, record.file))) !== record.sha256) throw new Error('report_candidate_output_changed');
      }
      return saved;
    }
    const work = await fs.mkdtemp(path.join(folder, 'work-'));
    for (const area of inputAreas) {
      await fs.cp(path.join(input, area), path.join(work, area), { recursive: true, preserveTimestamps: true });
    }
    await fs.copyFile(path.join(input, 'roots.json'), path.join(work, 'roots.json'));
    if (await snapshot(work) !== inputSha) throw new Error('report_candidate_snapshot_changed');
    const root = path.join(work, 'workspace');
    process.env.PROGRESSIVE_READING_SUBSCRIPTIONS_HOME = path.join(work, 'state');
    process.env.RSS_IMPORT_HOME = path.join(work, 'rss');
    process.env.PROGRESSIVE_READING_DATA_HOME = path.join(work, 'data');
    process.env.PROGRESSIVE_READING_ARTIFACT_HOME = path.join(work, 'artifacts');
    globalThis.fetch = async () => { throw new Error('network_disabled_for_report_candidate'); };
    for (const rel of ['state/subscriptions.json', 'state/activity.json', 'workspace/imports/subscriptions/active.json',
      'workspace/imports/rss-reading/review-ledger.v1.json', 'rss/state.json', 'video/state.json']) {
      const file = path.join(work, rel);
      await writeJson(file, relocate(await readJson(file), input, work, roots));
    }
    const { generateSummaries } = await import('../rss-reading/core.mjs');
    const { appendActivity, weekKey } = await import('./service.mjs');
    const unavailable = async () => { throw new Error('report_candidate_requires_production_input'); };
    const summary = await generateSummaries(root, { mode: kind, date, week: weekKey(date), executeDecisions: false,
      ingestSummaries: false, previewRunner: unavailable, readingRunner: unavailable });
    const result = await appendActivity(root, summary, { date, now: Date.parse(date + 'T21:00:00+08:00') });
    const outputs = {};
    for (const [key, entry] of Object.entries(result.outputs)) {
      if (!entry) continue;
      if (!path.resolve(entry.path).startsWith(work + path.sep)) throw new Error('report_candidate_output_outside_work');
      const sha256 = digest(await fs.readFile(entry.path));
      if (sha256 !== entry.sha256) throw new Error('report_candidate_output_hash_mismatch');
      outputs[key] = { file: path.relative(folder, entry.path), sha256, items: entry.item_count };
    }
    const receipt = { schema, kind, cycle, inputSha256: inputSha, status: result.status,
      finishedAt: new Date().toISOString(), outputs, publishable: false };
    await writeJson(file, receipt);
    return receipt;
  }, { waitMs: 5000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  calculateReport(...process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
