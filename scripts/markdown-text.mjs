export const BROWSER_DRAFT_BODY_LIMIT = 300000;

export function normalizeMarkdownText(value, maxChars = 200000) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, maxChars);
}
