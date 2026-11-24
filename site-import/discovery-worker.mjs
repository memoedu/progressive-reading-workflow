import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { discoverSite } from './discovery.mjs';

export async function discoverSiteInWorker(root, settings, runId, { onProgress, retryInventory }) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { root, settings, runId, retryInventory } });
  try {
    return await new Promise((resolve, reject) => {
      let progress = Promise.resolve();
      let answered = false;
      worker.on('message', message => {
        if (message.type === 'progress') {
          progress = progress.then(() => onProgress(message.detail));
          progress.catch(reject);
          return;
        }
        answered = true;
        progress.then(() => {
          if (message.type === 'success') resolve(message.inventory);
          else reject(Object.assign(new Error(message.error), { inventory: message.inventory }));
        }, reject);
      });
      worker.once('error', reject);
      worker.once('exit', code => {
        if (!answered) reject(new Error(`站点发现工作线程在回执前退出 (${code})`));
      });
    });
  } finally {
    await worker.terminate();
  }
}

if (!isMainThread && workerData?.runId) {
  const { root, settings, runId, retryInventory } = workerData;
  try {
    const inventory = await discoverSite(root, settings, runId, {
      retryInventory,
      onProgress: detail => parentPort.postMessage({ type: 'progress', detail })
    });
    parentPort.postMessage({ type: 'success', inventory });
  } catch (error) {
    parentPort.postMessage({ type: 'failure', error: error.message, inventory: error.inventory });
  } finally {
    parentPort.close();
  }
}
