import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlArticleToMarkdown } from "../scripts/browser-page-markdown.mjs";
import { fetchUrlWithoutBrowser, htmlDetails } from "../scripts/url-background-fetch.mjs";

const url = "https://fixture.example/reading";
const body = `<div class="instapaper_body"><h2>Article section</h2>
  <p>The opening paragraph contains enough text to distinguish the actual article from the shell.</p>
  <script type="math/tex">p_1</script><p>The last paragraph belongs to the declared article.</p></div>`;
const html = `<!doctype html><title>Synthetic article</title><body>
  <main><template id="B:0"></template><p>Loading shell</p></main>
  <div hidden id="S:0"><template id="P:1"></template></div>
  <div hidden id="S:1">${body}</div>
  <script>$RS("S:1","P:1");$RC("B:0","S:0")</script>
  <div hidden id="S:2"><p>${"Unrelated comment ".repeat(900)}</p></div>
  </body>`;

test("URL fetch and full snapshots select the same streamed article without running scripts", async () => {
  const fetched = await fetchUrlWithoutBrowser(url, {
    fetchImpl: async () => new Response(html, { headers: { "Content-Type": "text/html" } })
  });
  assert.equal(fetched.articleHtml, body);
  assert.match(fetched.visibleText, /last paragraph/u);
  assert.doesNotMatch(fetched.visibleText, /Loading shell|Unrelated comment|p_1/u);
  const fromSnapshot = htmlArticleToMarkdown({ html, sourceUrl: url, title: fetched.title });
  const fromFetch = htmlArticleToMarkdown({ html: fetched.articleHtml, sourceUrl: url, title: fetched.title });
  assert.deepEqual(fromSnapshot, fromFetch);
  assert.match(fromFetch.markdown, /\$p_1\$[\s\S]*The last paragraph belongs to the declared article\.$/u);
});

test("hidden, unconnected and ambiguous publisher article markers are ineligible", () => {
  const cases = [
    html.replace('id="B:0"', 'id="B:3"'),
    html.replace('$RC("B:0","S:0")', '$RS("S:0","P:1")'),
    html.replace('$RS("S:1","P:1")', '$RS("S:1","P:1");$RS("S:1","P:2")'),
    html.replace("<script>$RS", '<script type="application/json">$RS'),
    `<aside hidden>${body}</aside>`,
    body + body
  ];
  for (const candidate of cases) assert.equal(htmlDetails(candidate, url).articleHtml, undefined);
});

test("article marker does not override the existing authentication check", async () => {
  await assert.rejects(fetchUrlWithoutBrowser(url, {
    fetchImpl: async () => new Response(html.replace("<main>", '<main><form action="/login"><input type="password"></form>'),
      { headers: { "Content-Type": "text/html" } })
  }), { status: "requires_browser_auth", message: "password_form_detected" });
});

test("a unique visible publisher entry preserves linked sections in the network and snapshot converters", async () => {
  const entry = '<article class="entry"><h1>Curated reading</h1><div class="entry-content">' +
    '<p>Opening explanation of the topic.</p><ul>' +
    Array.from({length:18}, (_, i) => '<li><a href="/reading/' + i + '">Recommended article ' + i + '</a></li>').join('') +
    '</ul><p>Closing remarks from the author.</p></div></article>';
  const page = '<nav>Site navigation</nav><main>' + entry + '</main><aside>Unrelated catalog</aside>';
  const fetched = await fetchUrlWithoutBrowser(url, {fetchImpl:async () =>
    new Response(page,{headers:{"Content-Type":"text/html"}})});
  assert.equal(fetched.articleHtml,entry);
  const captured = htmlArticleToMarkdown({html:fetched.articleHtml,sourceUrl:url});
  assert.deepEqual(htmlArticleToMarkdown({html:page,sourceUrl:url}),captured);
  assert.match(captured.markdown,/Recommended article 17\]\(https:\/\/fixture\.example\/reading\/17\)/u);
  assert.match(captured.markdown,/Closing remarks from the author/u);
  assert.doesNotMatch(captured.markdown,/Site navigation|Unrelated catalog/u);
  assert.equal(htmlDetails('<main>'+entry+entry+'</main>',url).articleHtml,undefined);
  assert.equal(htmlDetails('<main hidden>'+entry+'</main>',url).articleHtml,undefined);
});
