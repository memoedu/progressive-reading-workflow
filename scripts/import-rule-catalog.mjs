export const IMPORT_RULES = Object.freeze({
  schema: "local-ir.import-rules/v1",
  advanced_imports_allowed: true,
  rules: [
    {
      id: "zhihu-column-all-articles", version: 1, enabled: true,
      title: "知乎专栏 → 全部文章",
      match: "知乎专栏主页（zhuanlan.zhihu.com/专栏名 或 zhihu.com/column/专栏名）",
      action: "完整枚举专栏文章与置顶文章，去重后逐篇导入；超过 50 篇自动分批。",
      boundary: "单篇 /p/文章编号 不展开。回答、视频等非文章条目单独计数。枚举不完整、登录或访问限制会显示失败，不按全集成功处理。"
    },
    {
      id: "youtube-subtitles", version: 2, enabled: true,
      title: "YouTube → 视频正文",
      match: "YouTube watch、youtu.be、shorts、live 单视频链接",
      action: "优先人工中文字幕，其次其他人工字幕或原语言自动字幕。没有字幕轨时下载音轨并转写，再使用标准预处理。",
      boundary: "音轨仅在缺字幕轨时下载。访问失败、转写异常或明显缺文保留失败。编辑细节记入审计。同一视频按 video ID 去重。"
    },
    {
      id: "standard-url", version: 1, enabled: true,
      title: "普通链接 → 单篇导入",
      match: "未命中高级规则的 HTTP(S) 链接",
      action: "使用已有标准采集、预处理、逐条回执与全局来源去重。",
      boundary: "已有正文、标注和人工优先级保持受保护。"
    }
  ]
});

export function zhihuColumnIdentity(value) {
  if (!IMPORT_RULES.rules.some(rule => rule.id === "zhihu-column-all-articles" && rule.enabled)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null;
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.replace(/\/+$/u, "");
    let slug;
    if (hostname === "zhuanlan.zhihu.com") slug = pathname.match(/^\/([A-Za-z0-9_-]+)$/u)?.[1];
    else if (["www.zhihu.com", "zhihu.com"].includes(hostname)) slug = pathname.match(/^\/column\/([A-Za-z0-9_-]+)$/u)?.[1];
    if (!slug || new Set(["p", "api", "write", "signin", "login", "search", "settings", "people", "column"]).has(slug.toLowerCase())) return null;
    return { id: slug, url: `https://www.zhihu.com/column/${slug}`, rule_id: "zhihu-column-all-articles" };
  } catch { return null; }
}
