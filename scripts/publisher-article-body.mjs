const HIDDEN = '[hidden], [inert], [aria-hidden="true"]';
const STREAM_SEGMENT_ID = /^S:[a-z0-9]+$/u;

function streamTargets(document) {
  const targets = new Map();
  // Inspect only React's literal completion references. Page code is never run.
  const completion = /\$(?:RS\("(S:[a-z0-9]+)",\s*"(P:[a-z0-9]+)"\)|RC\("(B:[a-z0-9]+)",\s*"(S:[a-z0-9]+)"\))/gu;
  for (const script of document.querySelectorAll('script:not([src]):not([type]), script:not([src])[type="text/javascript"]')) {
    for (const match of script.textContent.matchAll(completion)) {
      const source = match[1] || match[4];
      const target = match[2] || match[3];
      if (!targets.has(source)) targets.set(source, target);
      else if (targets.get(source) !== target) targets.set(source, null);
    }
  }
  return targets;
}

export function publisherArticleBody(document) {
  const candidates = document.body.querySelectorAll(".instapaper_body");
  if (candidates.length !== 1) return null;
  const [article] = candidates;
  let hidden = article.closest(HIDDEN);
  if (!hidden) return article;

  // A streamed segment only counts if its placeholders lead back to the page.
  const targets = streamTargets(document);
  const seen = new Set();
  while (hidden) {
    if (hidden.parentElement !== document.body || !hidden.matches('div[hidden]:not([inert], [aria-hidden="true"])')
        || !STREAM_SEGMENT_ID.test(hidden.id) || seen.has(hidden.id)) return null;
    seen.add(hidden.id);
    const targetId = targets.get(hidden.id);
    const placeholder = targetId && document.getElementById(targetId);
    if (!placeholder?.matches("template")) return null;
    hidden = placeholder.closest(HIDDEN);
  }
  return article;
}
