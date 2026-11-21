import fs from 'node:fs/promises';
import path from 'node:path';
import {digest, readJson} from '../subscription-workflow/config.mjs';
import {urlImportDedupeKey} from '../scripts/url-import-input.mjs';
import {runPath, sitePaths} from './store.mjs';

const captureFile = (directory, url) => path.join(directory, 'sources', digest(url) + '.json');

export async function capturedArticle(root, articleSource, url, {requireInventory = false} = {}) {
  const directory = runPath(root, articleSource.run_id);
  const captured = await readJson(captureFile(directory, url));
  if (!captured || captured.url !== url || !captured.markdown?.trim() || captured.excluded) {
    if (requireInventory) return null;
    throw new Error('整站正文缓存缺失或来源不符');
  }
  const inventory = await readJson(path.join(directory, 'inventory.json'));
  const article = inventory?.articles?.find(article => article.url === url);
  if (!article && requireInventory) return null;
  if (!article) return captured;
  if (article.markdown_sha256 !== digest(captured.markdown)) throw new Error('整站分类引用的正文哈希不符');
  return {...captured, metadata: {...captured.metadata, taxonomy: article.taxonomy}};
}

export async function findSiteArticleCapture(root, requestedUrl) {
  const {runs} = sitePaths(root);
  const dirs = await fs.readdir(runs).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const key = urlImportDedupeKey(requestedUrl);
  const slash = new URL(key);
  if (!slash.pathname.endsWith('/')) slash.pathname += '/';
  const urls = [...new Set([requestedUrl, key, slash.href])].filter(url => urlImportDedupeKey(url) === key);
  const candidates = await Promise.all(dirs.filter(id => /^site-run-[a-f0-9]{24}$/u.test(id)).flatMap(id => urls.map(async url => {
    const stat = await fs.stat(captureFile(runPath(root, id), url)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return stat?.isFile() ? {id, url, time: stat.mtimeMs} : null;
  })));
  for (const {id, url} of candidates.filter(Boolean).sort((a, b) => b.time - a.time)) {
    const capture = await capturedArticle(root, {run_id: id}, url, {requireInventory: true});
    if (capture) return capture;
  }
  return null;
}
