import { generatedSharedVersions } from './shared-library-client.mjs';
import { sharedArticleUrl } from './shared-library.mjs';
import { queueReadingPublication } from './reading-publication-outbox.mjs';

export async function synchronizeReadingPublication(root, {
  url, title, original, markdown, kind, processingOptions, versions, standardResult, reused = null
}, { queueRetry = queueReadingPublication } = {}) {
  if (reused) {
    return { shared_reading: { status: 'available', commit: reused.commit, original: reused.original,
      reading: reused.reading, reused: true } };
  }
  const canonical = sharedArticleUrl(url);
  if (!canonical || typeof original !== 'string' || !original.trim()) {
    return { shared_reading: { status: 'failed', reason: 'shared_invalid_reading' } };
  }
  const variants = markdown === undefined ? undefined : versions ?? (standardResult && generatedSharedVersions(standardResult));
  // Persist the captured bytes with the event before the background publisher can claim it.
  const request = { url: canonical, title, kind, original, markdown, processingOptions, versions: variants };
  return { shared_reading: await queueRetry(root, request, { status: 'queued' }) };
}
