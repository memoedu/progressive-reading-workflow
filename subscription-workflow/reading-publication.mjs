import { generatedSharedVersions, lookupSharedReadingArtifacts, resolveSharedSubscription, sharedLibrarySettings, syncSharedReading, syncSharedVersions } from './shared-library-client.mjs';
import { sharedArticleUrl, sharedDigest, sharedPublicWebCandidate } from './shared-library.mjs';
import { verifyPublicReadingSource } from './shared-library-sources.mjs';
import { queueReadingPublication } from './reading-publication-outbox.mjs';

// Source evidence is supplied by the producer of the original bytes, never by
// a UI route name. The sync server independently enforces the public-source policy.
export async function synchronizeReadingPublication(root, {
  url,
  original,
  archivedOriginalSha256,
  archiveHintSha256,
  publicCapture = false,
  markdown,
  defer = false,
  kind,
  processingOptions,
  versions,
  standardResult,
  indexed,
  reused = null
}, {
  settings = sharedLibrarySettings,
  lookupArtifacts = lookupSharedReadingArtifacts,
  verifySource = verifyPublicReadingSource,
  lookupOriginal = resolveSharedSubscription,
  syncReading = syncSharedReading,
  syncVersions = syncSharedVersions,
  queueRetry = queueReadingPublication
} = {}) {
  const local = reason => ({ shared_reading: { status: 'local_only', reason } });
  if (reused) {
    return { shared_reading: { status: 'available', commit: reused.commit, original: reused.original,
      reading: reused.reading, reused: true } };
  }
  const canonical = sharedArticleUrl(url);
  if (!canonical || typeof original !== 'string' || !original.trim()) return local('source_not_publicly_verified');
  const originalHash = sharedDigest(original);
  let archived = originalHash === archivedOriginalSha256;
  const archiveHint = originalHash === archiveHintSha256;
  const publicWeb = sharedPublicWebCandidate(canonical);
  try {
    const state = await settings(root);
    if (!state.enabled) return local('sharing_disabled');
    const recorded = indexed === undefined ? await lookupArtifacts(root, {
      url: canonical, kind, processingOptions, originalSha256: originalHash, includeReading: markdown !== undefined
    }).catch(() => null) : indexed;
    if (recorded?.original?.sha256 === originalHash) {
      archived = true;
      if (markdown === undefined || recorded.reading) {
        return { shared_reading: { status: 'available', commit: recorded.commit, original: recorded.original,
          ...(markdown !== undefined ? { reading: recorded.reading } : {}), reused: true } };
      }
    }
    if (!state.signed_in) return local('shared_account_or_source_missing');
    if (!archived && archiveHint) {
      const prior = await lookupOriginal(root, canonical, null, { lookupOnly: true });
      archived = prior?.status === 'available' && prior.sha256 === originalHash;
    }
    if (!archived && !publicCapture) {
      // Snapshots and generic publishers may contain private body changes.
      // Compare with public bytes locally before putting anything on the wire.
      if (!publicWeb) return local('source_not_publicly_verified');
      const source = await verifySource(canonical);
      if (!source?.markdown) return local('source_not_publicly_verified');
      if (source.markdown.trim() !== original.trim()) return local('public_source_body_mismatch');
    }
    const request = { url: canonical, kind, original, processingOptions, markdown };
    if (defer) return { shared_reading: await queueRetry(root, request, { status:'queued' }) };
    let sharedReading = await syncReading(root, request);
    if (sharedReading.status === 'retry_wait') {
      sharedReading = await queueRetry(root, request, sharedReading)
        .catch(() => ({ ...sharedReading, retry_error: 'shared_retry_persistence_failed' }));
    }
    const variants = archived && markdown !== undefined ? versions ?? (standardResult ? generatedSharedVersions(standardResult) : []) : [];
    const sharedVersions = variants.length ? await syncVersions(root, canonical, originalHash, variants) : [];
    return { shared_reading: sharedReading, ...(sharedVersions.length ? { shared_versions: sharedVersions } : {}) };
  } catch {
    return { shared_reading: { status: 'retry_wait', error: 'shared_sync_unavailable' } };
  }
}
