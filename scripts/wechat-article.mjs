export function isWechatArticleUrl(value) {
  if (!URL.canParse(value)) return false;
  const { hostname, pathname } = new URL(value);
  return hostname === "mp.weixin.qq.com" && (pathname === "/s" || pathname.startsWith("/s/"));
}

export function wechatArticleBody(document) {
  return document.getElementById("js_content") || document.querySelector(".rich_media_content");
}

export function wechatArticleMetadata(document) {
  const meta = (property) => document.querySelector(`meta[property="${property}"]`)?.content.trim();
  const text = (id) => document.getElementById(id)?.textContent.trim();
  return {
    title: meta("og:title") || text("activity-name") || "",
    author: meta("og:article:author") || text("js_author_name") || "",
    account: text("js_name") || "",
    publishedAt: meta("article:published_time") || text("publish_time") || ""
  };
}

export function prepareWechatArticleBody(body, sourceUrl) {
  for (const image of body.querySelectorAll("img[data-src]")) {
    const lazySrc = image.getAttribute("data-src");
    if (lazySrc && URL.canParse(lazySrc, sourceUrl)) {
      const url = new URL(lazySrc, sourceUrl);
      if (url.protocol === "https:" || url.protocol === "http:") image.setAttribute("src", url.href);
    }
  }
}
