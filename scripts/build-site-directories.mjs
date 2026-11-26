import path from 'node:path';
import { readJson } from '../subscription-workflow/config.mjs';
import { CODE_ROOT } from '../site-import/store.mjs';
import { publishSourceDirectories } from '../site-import/source-directories.mjs';

const [planFile, ...flags] = process.argv.slice(2);
if (!planFile || flags.some(flag => flag !== '--apply')) {
  throw new Error('用法：node scripts/build-site-directories.mjs <目录计划.json> [--apply]');
}

const plan = await readJson(path.resolve(planFile));
if (!Array.isArray(plan?.sites) || !plan.sites.length) throw new Error('目录计划需要包含 sites 列表');

const applied = flags.includes('--apply');
const receipt = await publishSourceDirectories(CODE_ROOT, plan, {
  apply: applied,
  onProgress: event => process.stderr.write(JSON.stringify(event) + '\n')
});
for (const site of new Set(receipt.files.map(file => file.site))) {
  const files = receipt.files.filter(file => file.site === site);
  const links = files.flatMap(file => file.links);
  console.log(JSON.stringify({ site, applied, files: files.length,
    articles: links.filter(link => link.kind === 'article').length,
    directories: links.filter(link => link.kind === 'directory').length,
    web: links.filter(link => link.kind === 'web').length }));
}
