import { sharedArticleUrl, sharedReadingSource } from './shared-library.mjs';
import { parseFeedDocument } from '../rss-source/core.mjs';
import { fetchArticleContent, originalArticleTarget } from '../rss-source/article-fetch.mjs';
import { fetchUrlWithoutBrowser } from '../scripts/url-background-fetch.mjs';
import { htmlArticleToMarkdown } from '../scripts/browser-page-markdown.mjs';

const maxDocumentBytes = 2 * 1024 * 1024;
const cacheAge = 5 * 60_000;

export const localOnly = reason => ({ status: 'local_only', reason });

export async function verifyPublicReadingSource(url, fetchImpl = fetch) {
  const source = sharedReadingSource(url);
  if (source === 'wechat') {
    const page = await fetchUrlWithoutBrowser(url, { timeoutMs: 15_000, fetchImpl: (target, options) => {
      if (sharedArticleUrl(target) !== url) throw new Error('shared_source_redirect_not_allowed');
      return fetchImpl(target, options);
    } });
    if (!page.articleHtml || !page.title || page.fetchReceipt.authenticated_fetch !== false) return null;
    return htmlArticleToMarkdown({ html: page.articleHtml, sourceUrl: url, title: page.title });
  }
  if (source !== 'bilibili') return null;
  const canonical = new URL(url);
  const bvid = canonical.pathname.split('/').at(-1);
  const part = Number(canonical.searchParams.get('p') || 1);
  const get = async (pathname, parameters) => {
    const target = new URL(pathname, 'https://api.bilibili.com/');
    target.search = new URLSearchParams(parameters).toString();
    const { text } = await anonymousText(target.href, new Set([target.origin]), (request, options) =>
      fetchImpl(request, { ...options, headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' } }));
    const result = JSON.parse(text);
    return result.code === 0 ? result.data : null;
  };
  const view = await get('/x/web-interface/view', { bvid });
  const cid = view?.pages?.find(page => page.page === part)?.cid;
  if (view?.bvid !== bvid || view.state !== 0 || !Number.isSafeInteger(cid) || view.rights?.pay || view.rights?.arc_pay || view.rights?.ugc_pay) return null;
  const media = await get('/x/player/playurl', { bvid, cid: String(cid), qn: '16', fnval: '0' });
  return media?.durl?.length && typeof view.title === 'string' ? { title: view.title } : null;
}

async function anonymousText(url, allowed, fetchImpl) {
  const parsed = new URL(url);
  if (!allowed.has(parsed.origin) || parsed.username || parsed.password) throw new Error('shared_source_redirect_not_allowed');
  const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(9_000) });
  if (!response.ok) throw Object.assign(new Error('shared_source_http_' + response.status), { status: response.status });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxDocumentBytes) throw new Error('shared_source_content_too_large');
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), response, finalUrl: response.url || url };
}

export function createPublicRssSources(sources, { fetchImpl = fetch, now = Date.now } = {}) {
  const catalog = sources.map(({ feed, folder, article_origins }) => {
    const url = new URL(feed);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
        typeof folder !== 'string' || !folder.trim() || folder.startsWith('.') || /[\\/:*?"<>|\x00-\x1f]/u.test(folder) ||
        !Array.isArray(article_origins) || !article_origins.length ||
        article_origins.some(origin => !sharedArticleUrl(origin) || new URL(origin).origin !== origin)) {
      throw new Error('shared_public_rss_config_invalid');
    }
    return { feed: url.href, folder, origins: new Set(article_origins), cached: null };
  });

  function feedItems(source) {
    if (source.cached && source.cached.expires > now()) return source.cached.items;
    const items = (async () => {
      const url = new URL(source.feed);
      const data = await anonymousText(source.feed, new Set([url.origin]), fetchImpl);
      const parsed = await parseFeedDocument(data.text, source.feed);
      return new Map(parsed.items.map(item => [sharedArticleUrl(item.item_url), item]));
    })().catch(error => { source.cached = null; throw error; });
    source.cached = { items, expires: now() + cacheAge };
    return items;
  }

  return async function fetchPublicRssArticle(url) {
    const origin = new URL(url).origin;
    for (const source of catalog) {
      if (!source.origins.has(origin)) continue;
      try {
        const item = (await feedItems(source)).get(url);
        if (!item) continue;
        const folder = source.folder;
        if (originalArticleTarget(url)) {
          const article = await fetchArticleContent(url, target => anonymousText(target, source.origins, fetchImpl));
          return { title: article.title || item.title, markdown: article.markdown, folder };
        }
        if (item.feed_content.status === 'fulltext_ready') {
          return { title: item.title, markdown: item.feed_content.markdown, folder };
        }
        const page = await fetchUrlWithoutBrowser(url, { timeoutMs: 9000, maxBytes: maxDocumentBytes,
          fetchImpl: (target, options) => {
            if (!source.origins.has(new URL(target).origin) || sharedArticleUrl(target) !== url) {
              throw new Error('shared_source_redirect_not_allowed');
            }
            return fetchImpl(target, options);
          } });
        if (!page.isHtml || page.fetchReceipt.authenticated_fetch !== false) return localOnly('source_not_publicly_verified');
        const article = htmlArticleToMarkdown({ html: page.body, sourceUrl: page.finalUrl, title: item.title || page.title });
        if (article.markdown.trim().length < Math.max(200, item.feed_content.markdown.length + 20)) {
          return localOnly('source_not_publicly_verified');
        }
        return { ...article, folder };
      } catch (error) {
        if (['requires_browser_auth', 'requires_js_render', 401, 403, 404].includes(error.status) ||
            /^original_article_(?:identity_or_access_invalid|unavailable)/u.test(error.message) ||
            error.message === 'shared_source_redirect_not_allowed') return localOnly('source_not_publicly_verified');
        throw error;
      }
    }
    return localOnly('source_not_in_public_feed');
  };
}
