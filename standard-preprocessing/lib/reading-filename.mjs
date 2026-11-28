import path from "node:path";
import { createHash } from "node:crypto";
import sanitizeFilename from "sanitize-filename";

const sidecarSuffix = ".browser-ir.json";

function cleanTitle(title) {
  return sanitizeFilename(title.replace(/[#^[\]]/gu, " "), { replacement: " " })
    .replace(/\s+/gu, " ").trim();
}

function fitTitle(text, bytes) {
  if (Buffer.byteLength(text) <= bytes) return text;
  let prefix = "";
  for (const character of text) {
    if (Buffer.byteLength(prefix + character + "…") > bytes) break;
    prefix += character;
  }
  return prefix.trimEnd() + "…";
}

export function bilingualReadingFilename(title, suffix = ".md") {
  const parts = typeof title === "string" ? title.split("｜") : [];
  if (parts.length !== 2 || !/\p{Script=Han}/u.test(parts[0]) || !/[A-Za-z]/u.test(parts[1])) return null;
  const [chinese, english] = parts.map(cleanTitle);
  const budget = 255 - Buffer.byteLength(suffix + sidecarSuffix + "｜");
  if (budget < 32 || !chinese || !english) return null;
  const chineseBudget = Math.min(budget - 8, Math.max(48, budget - Math.min(Buffer.byteLength(english), 144)));
  const first = fitTitle(chinese, chineseBudget);
  return first + "｜" + fitTitle(english, budget - Buffer.byteLength(first)) + suffix;
}

export function generatedReadingTitle(markdown) {
  const header = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/u.exec(String(markdown));
  if (!header || !/^translation_state:\s*["']?generated_translation["']?[ \t]*$/mu.test(header[1])) return null;
  return /^\s*# ([^\r\n]+)/u.exec(String(markdown).slice(header[0].length))?.[1] || null;
}

export function sharedReadingTitle(markdown) {
  const text = String(markdown).replaceAll('\r\n', '\n');
  const title = /^# ([^\n]+)\n/u.exec(text)?.[1];
  const body = text.indexOf('\n## 正文\n');
  const original = text.indexOf('\n---\n\n## 原文\n', body);
  return title && bilingualReadingFilename(title) && body >= 0 && original > body ? title : null;
}

export function readingTitlePublicationPath(target, title, sourceUrl) {
  const suffix = sourceUrl ? "--" + createHash("sha256").update(sourceUrl).digest("hex").slice(0, 10) + ".md" : ".md";
  const filename = bilingualReadingFilename(title, suffix);
  return filename ? path.join(path.dirname(target), filename) : target;
}
