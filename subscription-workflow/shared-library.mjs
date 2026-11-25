import { createHash } from 'node:crypto';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';

export const sharedRepository = 'memoedu/progressive-reading-library';
export const pilotOrigin = 'https://www.benkuhn.net';
export const sharedSchema = 'progressive-reading.shared-article/v1';
export const sharedDigest = value => createHash('sha256').update(value).digest('hex');
export const sha256Pattern = /^[0-9a-f]{64}$/u;
export const commitPattern = /^[0-9a-f]{40}$/u;

export function sharedArticleUrl(value) {
  try {
    const input = new URL(String(value || ''));
    if (input.protocol === 'http:' && input.hostname === 'www.ruanyifeng.com' && !input.port) input.protocol = 'https:';
    if (input.protocol !== 'https:' || input.port || input.username || input.password ||
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(input.hostname) || !/[a-z]/u.test(input.hostname.split('.').at(-1)) ||
        /\.(?:local|internal|localhost)$/u.test(input.hostname) || input.pathname.length > 900) return null;
    const url = new URL(urlImportDedupeKey(input.href));
    const parameters = [...url.searchParams];
    if (parameters.length) {
      const [key, value] = parameters[0];
      const numbered = (url.hostname === 'kirigaya.cn' && url.pathname === '/api/rss/blog' && key === 'seq') ||
        (url.hostname === 'www.bilibili.com' && /^\/video\/BV[0-9A-Za-z]{10}$/u.test(url.pathname) && key === 'p');
      if (parameters.length !== 1 || !numbered || !/^[1-9]\d{0,9}$/u.test(value)) return null;
    }
    return url.href;
  } catch { return null; }
}

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

export function sharedVariantPath(url, kind, sha256) {
  return '加工版本/' + sharedDigest(url).slice(0, 24) + '/' + kind + '-' + sha256 + '.md';
}

export const variantKind = value => value === 'translation' || value === 'reading_guide';
export const sharedReadingPath = (url, sha) => sharedVariantPath(url, 'reading', sha);
export const sharedOriginalRevisionPath = (url, sha) => '原稿/' + sharedDigest(url).slice(0, 24) + '/' + sha + '.md';

export function sharedReadingSource(url) {
  const canonical = sharedArticleUrl(url);
  if (!canonical) return null;
  const parsed = new URL(canonical);
  if (parsed.hostname === 'mp.weixin.qq.com' && /^\/s\/[\w-]+$/u.test(parsed.pathname)) return 'wechat';
  if (parsed.hostname === 'www.bilibili.com' && /^\/video\/BV[0-9A-Za-z]{10}$/u.test(parsed.pathname)) return 'bilibili';
  return null;
}
export const materialExtension = value => ['pdf', 'epub', 'docx', 'txt'].includes(value);
export const sharedMaterialIndexPath = hash => 'index/materials/' + hash + '.json';

export function sharedRecord(value, url) {
  const original = value?.original;
  if (value?.schema !== sharedSchema || value.url !== url || !sha256Pattern.test(original?.sha256 || '') ||
      typeof original?.path !== 'string' || !original.path.endsWith('.md') ||
      original.path.split('/').some(segment => !segment || segment.startsWith('.') || /[\\:\x00-\x1f]/u.test(segment))) {
    throw new Error('shared_library_invalid_index');
  }
  if (value.versions !== undefined && (!Array.isArray(value.versions) || value.versions.length > 40 ||
      value.versions.some(item => !variantKind(item?.kind) || !sha256Pattern.test(item.sha256 || '') ||
        item.path !== sharedVariantPath(url, item.kind, item.sha256)))) throw new Error('shared_library_invalid_index');
  const revisions = value.original_revisions ?? [];
  const readingFiles = value.reading_files ?? [];
  if (!Array.isArray(revisions) || !Array.isArray(readingFiles) ||
      revisions.some(item => !sha256Pattern.test(item?.sha256 || '') || item.path !== sharedOriginalRevisionPath(url, item.sha256)) ||
      readingFiles.some(item => !sha256Pattern.test(item?.sha256 || '') || !sha256Pattern.test(item?.processing_sha256 || '') ||
        item.path !== sharedReadingPath(url, item.sha256) ||
        (item.original_sha256 !== original.sha256 && !revisions.some(revision => revision.sha256 === item.original_sha256)))) {
    throw new Error('shared_library_invalid_index');
  }
  return value;
}

export function sharedMaterialRecord(value, hash) {
  if (value?.schema !== 'progressive-reading.shared-material/v1' || !sha256Pattern.test(hash || '') || value.sha256 !== hash ||
      !materialExtension(value.extension) || value.url !== sharedArticleUrl(value.url) || typeof value.url !== 'string' ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 25 * 1024 * 1024 ||
      value.path !== '原材料/' + value.extension.toUpperCase() + '/' + hash + '.' + value.extension ||
      (value.article_url !== undefined && (!value.article_url || value.article_url !== sharedArticleUrl(value.article_url) ||
        value.article_index !== sharedIndexPath(value.article_url)))) {
    throw new Error('shared_library_invalid_material_index');
  }
  return value;
}

export function sharedRawUrl(commit, path) {
  if (!commitPattern.test(commit)) throw new Error('shared_library_invalid_commit');
  return 'https://raw.githubusercontent.com/' + sharedRepository + '/' + commit + '/' +
    path.split('/').map(encodeURIComponent).join('/');
}
