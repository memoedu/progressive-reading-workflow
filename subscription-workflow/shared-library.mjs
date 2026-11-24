import { createHash } from 'node:crypto';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';

export const sharedRepository = 'memoedu/progressive-reading-library';
export const pilotOrigin = 'https://www.benkuhn.net';
export const sharedSchema = 'progressive-reading.shared-article/v1';
export const sharedDigest = value => createHash('sha256').update(value).digest('hex');
export const sha256Pattern = /^[0-9a-f]{64}$/u;
export const commitPattern = /^[0-9a-f]{40}$/u;

export function pilotArticleUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.origin !== pilotOrigin || url.username || url.password ||
        !/^\/[a-z0-9][a-z0-9/-]{0,160}\/?$/iu.test(url.pathname) ||
        [...url.searchParams.keys()].some(key => !/^utm_/iu.test(key))) return null;
    return urlImportDedupeKey(url.href);
  } catch { return null; }
}

export function sharedIndexPath(url) {
  return 'index/articles/' + sharedDigest(url) + '.json';
}

export function sharedRecord(value, url) {
  const original = value?.original;
  if (value?.schema !== sharedSchema || value.url !== url || !sha256Pattern.test(original?.sha256 || '') ||
      typeof original?.path !== 'string' || !original.path.endsWith('.md') ||
      original.path.split('/').some(segment => !segment || segment.startsWith('.') || /[\\:\x00-\x1f]/u.test(segment))) {
    throw new Error('shared_library_invalid_index');
  }
  return value;
}

export function sharedRawUrl(commit, path) {
  if (!commitPattern.test(commit)) throw new Error('shared_library_invalid_commit');
  return 'https://raw.githubusercontent.com/' + sharedRepository + '/' + commit + '/' +
    path.split('/').map(encodeURIComponent).join('/');
}
