import fs from 'node:fs/promises';
import path from 'node:path';
import LocalIrDocumentCore from '../document-core/index.mjs';
import { digest } from '../subscription-workflow/config.mjs';
import { replaceChecked } from '../subscription-workflow/report-archive.mjs';
import { sourceReuseResult, withSourcePublication } from '../scripts/reading-source-library.mjs';
import { BROWSER_DRAFT_BODY_LIMIT, normalizeMarkdownText } from '../scripts/markdown-text.mjs';
import { capturedArticle } from './article-capture.mjs';
import { runPath } from './store.mjs';

const { DOCUMENT_STATE_SCHEMA, DOCUMENT_STATE_VERSION } = LocalIrDocumentCore;

const readOptional = file => fs.readFile(file, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function keepOriginal(file, original) {
  const saved = await readOptional(file);
  if (saved !== null && saved !== original) throw new Error('整站原文恢复备份不一致');
  if (saved === null) await replaceChecked(file, null, original);
}

export async function recoverTruncatedOriginal(root, article, source, publication, previous) {
  const receipt = previous?.receipt;
  if (previous?.status !== 'imported' || receipt?.processing_mode !== 'original_text'
    || receipt.source_reused !== 'verified_site_capture' || !receipt.raw_markdown_sha256) return null;

  const url = article.url;
  const captured = await capturedArticle(root, source, url);
  const original = captured.markdown;
  const rawHash = digest(original);
  const normalized = normalizeMarkdownText(original, Infinity);
  if (rawHash !== receipt.raw_markdown_sha256 || normalized.length <= BROWSER_DRAFT_BODY_LIMIT) return null;

  return withSourcePublication(root, url, async () => {
    const file = publication.path;
    const body = await readOptional(file);
    const expected = previous.artifacts?.find(item => item.kind === 'markdown');
    const sidecar = path.join(root, '.local-ir', 'browser-document-state', path.basename(file) + '.browser-ir.json');
    const stateText = await readOptional(sidecar);
    const state = stateText === null ? null : JSON.parse(stateText);
    if (body?.includes(original.trim()) && state?.content?.markdownSha256 === digest(body)) return null;

    const protectedError = () => new Error('历史原文或阅读状态发生变化，需要核对后恢复：' + url);
    if (publication.zone !== '阅读区' || file !== expected?.path || !/^[a-f0-9]{64}$/u.test(expected.sha256)
      || state?.schema !== DOCUMENT_STATE_SCHEMA || state.schemaVersion !== DOCUMENT_STATE_VERSION || state.document?.sourceUrl !== url
      || state.document?.id !== receipt.draft_id || state.document.status !== 'inbox' || state.document.revision !== 0
      || state.content?.rawMarkdownSha256 !== rawHash || state.content.markdownSha256 !== expected.sha256
      || state.annotations?.length || state.qaCards?.length || state.articleMusing) throw protectedError();

    const recoveryDir = path.join(runPath(root, source.run_id), 'publication-recovery', expected.sha256);
    const bodyBackup = path.join(recoveryDir, 'previous.md');
    const stateBackup = path.join(recoveryDir, 'previous.state.json');
    const oldBody = (await readOptional(bodyBackup)) ?? body;
    const oldEnding = normalized.slice(0, BROWSER_DRAFT_BODY_LIMIT) + '\n';
    if (oldBody === null || digest(oldBody) !== expected.sha256 || !oldBody.endsWith(oldEnding)) throw protectedError();
    const corrected = oldBody.slice(0, -oldEnding.length) + original + '\n';
    if (body !== oldBody && body !== corrected) throw protectedError();

    await keepOriginal(bodyBackup, oldBody);
    await keepOriginal(stateBackup, stateText);
    if (await readOptional(sidecar) !== stateText) throw protectedError();
    const hash = digest(corrected);
    const correctedState = { ...state, content: { ...state.content, markdownSha256: hash } };
    await replaceChecked(file, body, corrected);
    await replaceChecked(sidecar, stateText, JSON.stringify(correctedState, null, 2) + '\n');

    const result = sourceReuseResult(url, { ...publication, sha256: hash });
    return { ...result, status: 'imported', receipt: { ...receipt, restored_truncated_publication: true,
      previous_markdown_sha256: expected.sha256, final_markdown_sha256: hash, recovery_dir: recoveryDir } };
  });
}
