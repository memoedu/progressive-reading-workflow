import fs from 'node:fs/promises';
import path from 'node:path';
import { sharedArticleUrl, sharedDigest } from './shared-library.mjs';
import { sharedReadingOptionsKey, sharedReadingProcessingKey } from './shared-library-client.mjs';
import { synchronizeReadingPublication } from './reading-publication.mjs';

function readJson(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
}

export async function reconcileReadingPublication(root, { url, file, retained, indexed }, {
  synchronize = synchronizeReadingPublication
} = {}) {
  const indexedOriginal = indexed?.original && { status: 'available', commit: indexed.commit, original: indexed.original, reused: true };
  const indexedReading = indexed?.reading && { ...indexedOriginal, reading: indexed.reading };
  const indexedReceipts = {
    ...(indexedOriginal ? { shared_original: indexedOriginal } : {}),
    ...(indexedReading ? { shared_reading: indexedReading } : {})
  };
  const rawHash = retained?.receipt?.raw_markdown_sha256;
  const audit = retained?.artifacts?.find(item => item.kind === 'standard_preprocess_audit');
  if (!rawHash || !audit || !file) return indexedReceipts;

  const request = await readJson(path.join(audit.path, 'request.json'));
  const original = request?.material?.markdown;
  const sources = [request?.source_metadata?.source_url, request?.source_metadata?.canonical_url].map(sharedArticleUrl);
  if (!sources.includes(sharedArticleUrl(url)) || typeof original !== 'string' || sharedDigest(original) !== rawHash) return indexedReceipts;

  const artifact = retained.artifacts.find(item => item.kind === 'markdown');
  const sidecar = retained.artifacts.find(item => item.kind === 'browser_ir_metadata');
  const state = sidecar && await readJson(sidecar.path);
  const bytes = await fs.readFile(file).catch(() => null);
  const generated = bytes && artifact?.sha256 === sharedDigest(bytes) && state?.content?.markdownSha256 === artifact.sha256 &&
    !request.user_instruction?.trim() && !state.annotations?.length && !state.qaCards?.length && !state.articleMusing &&
    !retained.receipt.supersedes_publication;
  const processingOptions = request.processing_options;
  const indexedOwnOriginal = indexedOriginal?.original.sha256 === rawHash;
  const matchingEdition = indexedOwnOriginal && indexedReading &&
    (indexedReading.reading.options_sha256 === sharedReadingOptionsKey({ processingOptions }) ||
      indexedReading.reading.processing_sha256 === sharedReadingProcessingKey({ processingOptions }));
  if (matchingEdition) return indexedReceipts;

  const source = { url, title: request.source_metadata?.title, original, processingOptions };
  const { shared_reading: originalReceipt } = indexedOwnOriginal ? { shared_reading: indexedOriginal }
    : await synchronize(root, source);
  const readingReceipts = generated ? await synchronize(root, { ...source, markdown: bytes.toString('utf8') }) : {};
  return { ...indexedReceipts, shared_original: originalReceipt, ...readingReceipts };
}
