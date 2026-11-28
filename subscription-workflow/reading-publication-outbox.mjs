import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, withLock, writeJson } from './config.mjs';
import { sharedLibrarySettings, sharedReadingOptionsKey, syncSharedReading, syncSharedVersions } from './shared-library-client.mjs';
import { sha256Pattern, sharedDigest } from './shared-library.mjs';

const directory = root => path.join(root, '.local-ir', 'shared-reading-publications');
const recordPath = (root, id) => path.join(directory(root), id + '.json');
const retryDelay = attempts => Math.min(60, 2 ** Math.min(attempts - 1, 6)) * 60_000;
const formerEligibilityReasons = new Set(['source_not_publicly_verified', 'public_source_body_mismatch',
  'video_source_not_publicly_verified', 'personal_or_existing_document']);
const currentReceipt = record => record && !formerEligibilityReasons.has(record.receipt?.reason) ? record.receipt : null;

function publicationId(request) {
  return sharedDigest(JSON.stringify([
    request.url, sharedDigest(request.original),
    request.markdown === undefined ? null : sharedDigest(request.markdown),
    sharedReadingOptionsKey(request)
  ]));
}

export async function queueReadingPublication(root, request, receipt, now = Date.now()) {
  const id = publicationId(request);
  const file = recordPath(root, id);
  const existing = await readJson(file);
  if (currentReceipt(existing)) return existing.receipt;
  return withLock(file + '.lock', async () => {
    const previous = await readJson(file);
    if (currentReceipt(previous)) return previous.receipt;
    const saved = { ...receipt, sync_id: id };
    const attempts = receipt.status === 'queued' ? 0 : 1;
    await writeJson(file, { attempts, retry_at: attempts ? now + retryDelay(attempts) : now, request, receipt: saved });
    return saved;
  }, { waitMs: 2000 });
}

export async function readingPublicationReceipt(root, id) {
  if (!sha256Pattern.test(id)) return null;
  return (await readJson(recordPath(root, id)))?.receipt ?? null;
}

export async function retryReadingPublications(root, {
  now = Date.now(), settings = sharedLibrarySettings, syncReading = syncSharedReading, syncVersions = syncSharedVersions,
  eventId = null
} = {}) {
  if (eventId !== null && !sha256Pattern.test(eventId)) throw new Error('invalid_publication_event_id');
  const files = eventId ? [eventId + '.json'] : await fs.readdir(directory(root)).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (!files.length) return null;
  const state = await settings(root);
  if (!state.enabled || !state.signed_in) return null;
  for (const name of files) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const file = path.join(directory(root), name);
    const record = await readJson(file);
    if (!record?.request || record.retry_at > now) continue;
    try {
      return await withLock(file + '.lock', async () => {
        const current = await readJson(file);
        if (!current?.request || current.retry_at > now) return null;
        const id = name.slice(0, -5);
        const result = publicationId(current.request) === id
          ? await syncReading(root, current.request).catch(() => ({ status:'retry_wait', error:'shared_sync_unavailable' }))
          : { status:'local_only', reason:'queued_publication_changed' };
        if (['sharing_disabled', 'shared_account_or_source_missing'].includes(result.reason)) return null;
        const variants = result.status === 'available' && !result.reused && current.request.versions?.length
          ? await syncVersions(root, current.request.url, result.original.sha256, current.request.versions) : [];
        const receipt = { ...result, sync_id: id, ...(variants.length ? { shared_versions: variants } : {}) };
        const attempts = current.attempts + 1;
        await writeJson(file, { attempts, receipt, ...(result.status === 'retry_wait'
          ? { retry_at: now + retryDelay(attempts), request: current.request } : {}) });
        return receipt;
      });
    } catch (error) {
      if (!/该操作正在执行/u.test(error.message)) throw error;
    }
  }
  return null;
}
