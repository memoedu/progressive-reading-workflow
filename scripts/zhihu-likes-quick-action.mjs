import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { resultView } from "./browser-import-web/client.mjs";
import { sourceUrls } from "./reading-source-library.mjs";
import { urlImportDedupeKey } from "./url-import-input.mjs";
import { withLock } from "../subscription-workflow/config.mjs";

const destinationFolder = "知乎/知乎点赞";
const importRoute = "/api/browser-import/requests";
const likesRoute = "/api/social-archive/zhihu/recent-likes";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(file, value, { exclusive = false } = {}) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (exclusive) await fs.link(temporary, file);
    else await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function localJson(port, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
    redirect: "error"
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `http_${response.status}`);
  return data;
}

function validLike(item) {
  const url = item?.source_url || "";
  const answer = /^https:\/\/www\.zhihu\.com\/question\/\d+\/answer\/(\d+)$/u.exec(url);
  const article = /^https:\/\/zhuanlan\.zhihu\.com\/p\/(\d+)$/u.exec(url);
  return (item?.verb === "MEMBER_VOTEUP_ANSWER" && item.content_type === "answer" && answer?.[1] === item.content_id)
    || (item?.verb === "MEMBER_VOTEUP_ARTICLE" && item.content_type === "article" && article?.[1] === item.content_id);
}

function validateInventory(inventory, limit) {
  const { items, urls, boundary, boundary_reason: boundaryReason } = inventory;
  if (inventory.requested !== limit || !Array.isArray(items) || items.length !== limit
    || items.some(item => !validLike(item) || !Number.isInteger(item.created_time) || item.created_time < 1)
    || items.some((item, index) => index > 0 && item.created_time > items[index - 1].created_time)
    || !Array.isArray(urls) || urls.length !== limit || new Set(urls).size !== limit
    || items.some((item, index) => item.source_url !== urls[index])
    || sha256(JSON.stringify(items)) !== inventory.inventory_sha256) {
    throw new Error("zhihu_recent_likes_inventory_invalid");
  }
  // Earlier service versions returned the next item without a boundary-reason field.
  if (boundary ? !validLike(boundary) || urls.includes(boundary.source_url)
    || !Number.isInteger(boundary.created_time) || boundary.created_time < 1 || boundary.created_time > items.at(-1).created_time
    : boundaryReason !== "feed_end") {
    throw new Error("zhihu_recent_likes_boundary_unverified");
  }
}

async function freezeInventory(request, file, limit) {
  let frozen = await readJson(file);
  if (!frozen) {
    const { items, urls, boundary, boundary_reason, pages_read, requested, inventory_sha256, profile_token } = await request(
      likesRoute, { action: "preview", limit }
    );
    if (!/^[0-9A-Za-z_-]+$/u.test(profile_token || "")) throw new Error("zhihu_inventory_account_missing");
    const inventory = { items, urls, boundary, boundary_reason, pages_read, requested, inventory_sha256, profile_token };
    validateInventory(inventory, limit);
    frozen = { inventory, sha256: sha256(JSON.stringify(inventory)), frozen_at: new Date().toISOString() };
    try {
      await writeJson(file, frozen, { exclusive: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      frozen = await readJson(file);
    }
  }
  if (sha256(JSON.stringify(frozen.inventory)) !== frozen.sha256) throw new Error("frozen_inventory_changed");
  validateInventory(frozen.inventory, limit);
  return frozen.inventory;
}

async function verifyBodies(readingRoot, results, verified = []) {
  const previouslyVerified = new Map(verified.map(row => [row.url, row]));
  const expected = new Map();
  const bodies = [];
  for (const result of results) {
    const view = resultView(result);
    if (view.kind !== "success") throw new Error("standard_import_unverified_artifact");
    const file = await fs.realpath(view.path);
    const relative = path.relative(readingRoot, file);
    const reused = result.status === "idempotent_replay" && result.receipt?.existing_article_preserved === true;
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || (!reused && path.dirname(relative) !== path.normalize(destinationFolder))) {
      throw new Error("standard_import_wrong_destination");
    }
    const data = await fs.readFile(file);
    const markdown = data.toString("utf8");
    const keys = sourceUrls(markdown).map(urlImportDedupeKey);
    const aliases = [result.requested_url, result.final_url, result.source_metadata?.canonical_url]
      .filter(Boolean).map(urlImportDedupeKey);
    const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").trim();
    const prior = previouslyVerified.get(result.requested_url);
    const currentHash = sha256(data);
    const sameVerifiedFile = prior?.path === file && prior.sha256 === view.hash;
    if (!body || !keys.some(key => aliases.includes(key)) || (currentHash !== view.hash && !sameVerifiedFile)) {
      throw new Error("standard_import_body_identity_or_hash_mismatch");
    }
    for (const alias of aliases) {
      if (expected.has(alias) && expected.get(alias) !== file) throw new Error("reading_area_duplicate_source_url");
      expected.set(alias, file);
    }
    bodies.push({ url: result.requested_url, path: file, sha256: view.hash, status: result.status, existing_body_reused: reused,
      ...(currentHash !== view.hash && { current_sha256: currentHash }) });
  }

  for (const entry of await fs.readdir(readingRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const file = path.join(entry.parentPath, entry.name);
    const handle = await fs.open(file, "r");
    try {
      const header = Buffer.alloc(16_384);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      for (const key of sourceUrls(header.subarray(0, bytesRead).toString("utf8")).map(urlImportDedupeKey)) {
        if (expected.has(key) && expected.get(key) !== file) throw new Error("reading_area_duplicate_source_url");
      }
    } finally {
      await handle.close();
    }
  }
  return bodies;
}

function verifiedStates(result, items) {
  const states = [...(result?.verification?.answer_states || []), ...(result?.verification?.article_states || [])];
  const expected = new Map(items.map(item => [item.source_url, item.content_id]));
  if (states.length !== expected.size || new Set(states.map(row => row.source_url)).size !== expected.size ||
    states.some(row => !expected.has(row.source_url) || String(row.content_id) !== expected.get(row.source_url) ||
      ![-1, 0, 1].includes(row.voting))) {
    throw new Error("zhihu_exact_vote_state_unverified");
  }
  return states;
}

async function cleanVerifiedLikes(request, inventory, runDir, expectedProfile) {
  const file = path.join(runDir, "cleanup-receipt.json");
  const previous = await readJson(file);
  if (previous?.inventorySha256 && previous.inventorySha256 !== inventory.inventory_sha256) throw new Error("zhihu_cleanup_checkpoint_mismatch");
  const profile = expectedProfile || inventory.profile_token || previous?.profile_token;
  if (!/^[0-9A-Za-z_-]+$/u.test(profile || "")) throw new Error("zhihu_cleanup_account_missing");
  if ((inventory.profile_token && inventory.profile_token !== profile) || (previous?.profile_token && previous.profile_token !== profile)) {
    throw new Error("zhihu_cleanup_account_mismatch");
  }
  if (previous?.status === "cleanup_verified") {
    if (verifiedStates(previous, inventory.items).every(row => row.voting === 0)) return previous;
    throw new Error("zhihu_cleanup_checkpoint_unverified");
  }
  const profileFields = profile ? { profile_token: profile } : {};
  const operations = [...(previous?.operations || [])];
  const save = (status, details = {}) => writeJson(file, {
    status, inventorySha256: inventory.inventory_sha256, profile_token: profile, operations, ...details
  });
  try {
    // Read every target before changing any platform state. A 403 or missing voting field is a stop condition.
    const state = await request(likesRoute, { action: "state", items: inventory.items, ...profileFields });
    const before = verifiedStates(state, inventory.items);
    const activeUrls = new Set(before.filter(row => row.voting === 1).map(row => row.source_url));
    const active = inventory.items.filter(item => activeUrls.has(item.source_url));
    for (let index = 0; index < active.length; index += 5) {
      const items = active.slice(index, index + 5);
      const response = await request(likesRoute, { action: "unlike", items, ...profileFields, allow_account_mutation: true, readback: "account" });
      operations.push(...(response.operations || []));
      await save("cleanup_pending", { verification: response.verification });
      if (response.status !== "cleanup_verified" || verifiedStates(response, items).some(row => row.voting !== 0)) {
        throw new Error(response.verification_error || "zhihu_cleanup_not_verified");
      }
    }
    const final = active.length ? await request(likesRoute, { action: "state", items: inventory.items, ...profileFields }) : state;
    const states = verifiedStates(final, inventory.items);
    if (states.some(row => row.voting !== 0)) throw new Error("zhihu_cleanup_final_readback_not_neutral");
    await save("cleanup_verified", { verification: final.verification, boundary: inventory.boundary, boundary_reason: inventory.boundary_reason });
    return readJson(file);
  } catch (error) {
    await save("cleanup_unverified", { error: error.message });
    throw error;
  }
}

export async function runQuickAction(input, { limit, dataRoot, readingRoot, request, expectedProfile, waitMs = 3_300_000, pollMs = 4000 }) {
  if (typeof input?.operationId !== "string" || !input.operationId.trim() || input.operationId.length > 512
    || input.text !== "" || !input.fields || Array.isArray(input.fields)
    || typeof input.fields !== "object" || Object.keys(input.fields).length) {
    return { state: "failed", detail: "快捷操作需要有效的操作 ID，且不接受录音内容或附加字段。" };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { state: "failed", detail: "知乎点赞导入条数必须是 1 至 50 的整数。" };
  }
  const runId = sha256(input.operationId);
  const runDir = path.join(dataRoot, "SocialReading", "zhihu-likes", runId);
  return withLock(path.join(runDir, "operation.lock"), () =>
    runArchive(input, { limit, readingRoot, request, expectedProfile, waitMs, pollMs, runDir, runId }));
}

async function runArchive(input, { limit, readingRoot, request, expectedProfile, waitMs, pollMs, runDir, runId }) {
  const receiptPath = path.join(runDir, "operation-receipt.json");
  const health = await request("/api/highlights/health");
  if (health.status !== "ok") throw new Error("progressive_reading_service_unavailable");
  const root = await fs.realpath(readingRoot);
  await fs.mkdir(runDir, { recursive: true });
  const inventory = await freezeInventory(request, path.join(runDir, "inventory.json"), limit);
  const clientRequestId = `zhihu-likes-quick-${runId}`;
  const checkpointPath = path.join(runDir, "standard-request.json");
  const standardReceiptPath = path.join(runDir, "standard-receipt.json");
  const importReceiptPath = path.join(runDir, "import-verification.json");
  let submitted = await readJson(checkpointPath);
  let result;
  let bodies;
  try {
    if (!submitted) {
      const accepted = await request(importRoute, {
        urls: inventory.urls, source: "archive-social-reading:zhihu-likes",
        entry_route: "ai", destination_folder: destinationFolder, client_request_id: clientRequestId
      });
      submitted = { requestId: accepted.request_id, inventorySha256: inventory.inventory_sha256 };
      if (!submitted.requestId) throw new Error("standard_import_request_id_missing");
      await writeJson(checkpointPath, submitted);
    }
    if (!submitted.requestId || submitted.inventorySha256 !== inventory.inventory_sha256) {
      throw new Error("standard_import_checkpoint_mismatch");
    }
    const deadline = Date.now() + waitMs;
    let terminal = await readJson(standardReceiptPath);
    if (terminal?.terminal !== true) {
      do {
        terminal = await request(`${importRoute}/${encodeURIComponent(submitted.requestId)}`);
        if (terminal.request_id !== submitted.requestId) throw new Error("standard_import_request_id_mismatch");
        if (terminal.terminal === true) break;
        if (Date.now() < deadline) await delay(pollMs);
      } while (Date.now() < deadline);
      await writeJson(standardReceiptPath, terminal);
    }
    if (terminal.request_id !== submitted.requestId) throw new Error("standard_import_request_id_mismatch");

    const byUrl = new Map((terminal.results || []).map(row => [row.requested_url, row]));
    const results = inventory.urls.map(url => byUrl.get(url));
    const complete = terminal.terminal === true && terminal.status === "completed" && terminal.results?.length === limit
      && results.every(row => row && ["imported", "idempotent_replay"].includes(row.status));
    if (complete) {
      const prior = await readJson(importReceiptPath) || await readJson(receiptPath);
      const priorBodies = prior?.state === "completed" && prior.operationId === input.operationId &&
        prior.requestId === submitted.requestId && prior.inventorySha256 === inventory.inventory_sha256 && prior.bodies?.length === limit
        ? prior.bodies : [];
      bodies = await verifyBodies(root, results, priorBodies);
      await writeJson(importReceiptPath, { state: "completed", operationId: input.operationId, requestId: submitted.requestId,
        inventorySha256: inventory.inventory_sha256, bodies });
      const cleanup = await cleanVerifiedLikes(request, inventory, runDir, expectedProfile);
      const reused = bodies.filter(row => row.existing_body_reused).length;
      const detail = `已逐条回读最新 ${limit} 条知乎点赞，${limit - reused} 条落入「知乎/知乎点赞」，${reused} 条复用阅读区已有正文。知乎端已确认 ${limit} 条均取消点赞。`;
      result = { state: "completed", detail, bodies, cleanup: { status: cleanup.status, verified: limit } };
    } else {
      const ready = results.filter(row => row && ["imported", "idempotent_replay"].includes(row.status)).length;
      result = terminal.terminal === true
        ? { state: "failed", detail: `标准导入确认 ${ready}/${limit} 条，状态 ${terminal.status}。回执 ${submitted.requestId}。` }
        : { state: "unknown", detail: `标准导入仍在运行（${ready}/${limit}）。回执 ${submitted.requestId}。` };
    }
  } catch (error) {
    result = { state: "unknown", detail: bodies ? `已核对 ${bodies.length} 条导入，取消点赞待核对。${error.message}`
      : `导入结果待核对。${error.message}`, ...(bodies && { bodies }) };
  }
  const receipt = { ...result, operationId: input.operationId, inventorySha256: inventory.inventory_sha256,
    requestId: submitted?.requestId, destinationFolder, recordedAt: new Date().toISOString() };
  await writeJson(receiptPath, receipt);
  return { state: result.state, detail: result.detail };
}

async function main() {
  let state;
  try {
    const [dataRoot, rawLimit = "20", rawPort = "37829", ...extra] = process.argv.slice(2);
    const port = Number(rawPort);
    if (!dataRoot || !path.isAbsolute(dataRoot) || extra.length || !Number.isInteger(port) || port < 37829 || port > 37849) {
      throw new Error("quick_action_local_configuration_invalid");
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 8192) throw new Error("quick_action_input_too_large");
      chunks.push(chunk);
    }
    state = await runQuickAction(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
      limit: Number(rawLimit), dataRoot, readingRoot: fileURLToPath(new URL("../阅读区/", import.meta.url)),
      request: (route, body) => localJson(port, route, body)
    });
  } catch (error) {
    state = { state: "failed", detail: error.message };
  }
  process.stdout.write(`${JSON.stringify(state)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
