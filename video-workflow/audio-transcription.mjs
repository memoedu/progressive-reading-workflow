import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function validateReceipt(raw,audio,provider) {
  if (raw.schema_version !== 1 || raw.source_sha256 !== audio.sha256 || !raw.route || !raw.utterances?.length) {
    throw new Error('audio_transcription_source_mismatch');
  }
  if ((['bailian','tingwu'].includes(provider) || raw.route === 'standard' || raw.cleanup) &&
      (raw.cleanup?.deleted !== true || raw.cleanup?.prefix_empty !== true)) {
    throw new Error('audio_cloud_cleanup_unverified');
  }
}

export async function transcribeAudioFile(audio,outputDir,{provider='auto'}={}) {
  const rawFile = path.join(outputDir,'raw.json');
  let raw = await fs.readFile(rawFile,'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!raw) {
    const cli = process.env.PROGRESSIVE_READING_ASR_CLI || path.join(os.homedir(),'.codex','skills','global-transcription','scripts','transcribe.py');
    let result;
    try {
      const {stdout} = await execute(process.env.PROGRESSIVE_READING_ASR_PYTHON || 'python',
        [cli,'transcribe',audio.path,'--provider',provider,'--route','auto','--output-dir',outputDir],
        {windowsHide:true,timeout:30*60_000,maxBuffer:8*1024*1024,encoding:'utf8',
          env:{...process.env,PYTHONIOENCODING:'utf-8'}});
      result = JSON.parse(stdout.replace(/^\uFEFF/u,''));
    } catch {
      throw new Error('global_audio_transcription_failed');
    }
    if (result.ok !== true || result.source_sha256 !== audio.sha256 || path.resolve(result.output_dir || '') !== outputDir
        || (provider !== 'auto' && result.provider !== provider)) throw new Error('audio_asr_receipt_mismatch');
    provider = result.provider;
    raw = await fs.readFile(rawFile,'utf8');
  }
  const receipt = JSON.parse(raw);
  validateReceipt(receipt,audio,provider);
  return receipt;
}
