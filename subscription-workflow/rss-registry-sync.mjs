import {execFile} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJson} from './config.mjs';
import {registryState} from './remote-feed-stage.mjs';

function exchangeRegistry(binding, operation, input) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/u.test(binding.host || '') ||
      !/^\/Users\/[A-Za-z0-9._-]+$/u.test(binding.home || '')) throw new Error('rss_registry_binding_invalid');
  const prefix = binding.home;
  const command = `exec ${prefix}/.local/bin/node ${prefix}/Agent/Projects/progressive-reading-workflow/subscription-workflow/remote-feed-stage.mjs ${operation} ${prefix}/Agent/AppData/ProgressiveReading/SubscriptionFeedCapture`;
  return new Promise((resolve,reject) => {
    const child = execFile('ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
      '-o','UpdateHostKeys=no','-o','ClearAllForwardings=yes','-o','ForwardAgent=no','-o','ConnectTimeout=3',
      binding.host,command],{windowsHide:true,timeout:5000,maxBuffer:32*1024},(error,stdout) => {
      if (error) reject(new Error('rss_registry_ssh_unconfirmed'));
      else resolve(stdout);
    });
    child.stdin.on('error',() => {});
    child.stdin.end(input);
  });
}

export async function reconcileFeedRegistry(subscriptionHome, {verify=false,send=exchangeRegistry}={}) {
  const binding = await readJson(path.join(subscriptionHome,'remote-rss-binding.json'));
  if (binding?.enabled !== true) return {status:'binding_disabled'};
  // The durable subscription file is also the retry source after an offline save.
  const { projection, ...expected } = registryState(await readJson(path.join(subscriptionHome,'subscriptions.json')));
  const input = verify ? undefined : JSON.stringify(projection);
  if (input && Buffer.byteLength(input) > 256*1024) throw new Error('rss_registry_projection_too_large');
  const result = JSON.parse(await send(binding,verify ? 'registry' : 'publish-registry',input));
  if (result?.revision !== expected.revision || result.enabled !== expected.enabled ||
      result.feeds !== expected.feeds || result.sha256 !== expected.sha256 ||
      (!verify && !['replaced','already_current'].includes(result.status))) throw new Error('rss_registry_readback_mismatch');
  return {status:verify ? 'verified' : result.status,...expected};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [subscriptionHome,operation='publish']=process.argv.slice(2);
  try {
    if (!path.isAbsolute(subscriptionHome || '') || !['verify','publish'].includes(operation)) throw new Error('rss_registry_command_invalid');
    console.log(JSON.stringify(await reconcileFeedRegistry(subscriptionHome,{verify:operation==='verify'})));
  } catch {
    console.error('rss_registry_sync_pending');
    process.exitCode=1;
  }
}
