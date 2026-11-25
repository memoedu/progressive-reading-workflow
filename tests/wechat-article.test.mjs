import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlArticleToMarkdown } from "../scripts/browser-page-markdown.mjs";
import { fetchUrlWithoutBrowser } from "../scripts/url-background-fetch.mjs";

const articleUrl = "https://mp.weixin.qq.com/s/synthetic-article";
const article = `<!doctype html><html><head>
  <meta property="og:title" content="公众号采集合成文章">
  <meta property="og:article:author" content="文章作者">
  </head><body><nav>公众号页面导航</nav><span id="js_name">测试公众号</span>
  <div id="js_content"><h2>原来的小节</h2><p>这段文字属于正文。</p>
  <p><img src="/placeholder.gif" data-src="//fixture.example/photo.png" alt="合成配图"></p>
  <p><a href="/s/related">相关文章</a></p><p><strong>正文末尾。</strong></p></div>
  <footer>页面底部操作</footer></body></html>`;
const htmlResponse = (body, headers = {}) => new Response(body, {
  headers: { "content-type": "text/html; charset=utf-8", ...headers }
});

test("WeChat article requests accept a bounded response over the ordinary limit", async () => {
  const padding = `<!--${"x".repeat(4096)}-->`.repeat(2048);
  const fetched = await fetchUrlWithoutBrowser(articleUrl, {
    fetchImpl: async (url, request) => {
      assert.equal(url, articleUrl);
      assert.match(request.headers["User-Agent"], /Chrome\//u);
      return htmlResponse(padding + article);
    }
  });
  assert.equal(fetched.title, "公众号采集合成文章");
  assert.equal(fetched.sourceMetadata.author, "文章作者");
  assert.equal(fetched.sourceMetadata.publisher, "测试公众号");
  assert.ok(fetched.sourceMetadata.content_integrity.received_body_bytes > 8 * 1024 * 1024);
  assert.equal(fetched.sourceMetadata.content_integrity.complete, true);
  assert.doesNotMatch(fetched.visibleText, /页面导航|底部操作/u);

  for (const [url, length] of [[articleUrl, 16 * 1024 * 1024 + 1], ["https://fixture.example/", 8 * 1024 * 1024 + 1]]) {
    await assert.rejects(fetchUrlWithoutBrowser(url, {
      fetchImpl: async () => htmlResponse(article, { "content-length": String(length) })
    }), /url_fetch_content_too_large/u);
  }
});

test("WeChat Markdown uses the complete article container and lazy image URLs", () => {
  const result = htmlArticleToMarkdown({ html: article, sourceUrl: articleUrl });
  assert.equal(result.method, "wechat_article_body");
  assert.equal(result.title, "公众号采集合成文章");
  assert.equal(result.byline, "文章作者");
  assert.match(result.markdown, /## 原来的小节/u);
  assert.match(result.markdown, /!\[合成配图\]\(https:\/\/fixture\.example\/photo\.png\)/u);
  assert.match(result.markdown, /\[相关文章\]\(https:\/\/mp\.weixin\.qq\.com\/s\/related\)/u);
  assert.match(result.markdown, /\*\*正文末尾。\*\*$/u);
  assert.doesNotMatch(result.markdown, /公众号页面导航|测试公众号|页面底部操作|placeholder\.gif/u);
});

test("WeChat verification screens and missing article containers cannot become articles", async () => {
  await assert.rejects(fetchUrlWithoutBrowser(articleUrl, {
    fetchImpl: async () => htmlResponse('<h2 class="weui-msg__title">环境异常</h2><div id="js_content"></div>')
  }), { status: "requires_browser_auth", message: "wechat_article_verification_required" });
  await assert.rejects(fetchUrlWithoutBrowser(articleUrl, {
    fetchImpl: async () => htmlResponse('<article>页面提示</article>')
  }), { status: "requires_js_render", message: "wechat_article_body_unavailable" });
  assert.throws(() => htmlArticleToMarkdown({ html: '<p>页面提示</p>', sourceUrl: articleUrl }), /wechat_article_body_unavailable/u);
});
