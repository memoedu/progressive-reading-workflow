import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { resultView } from "./browser-import-web/client.mjs";
import { sourceUrls } from "./reading-source-library.mjs";
import { urlImportDedupeKey } from "./url-import-input.mjs";

const destinationFolder = "知乎/知乎点赞";
const importRoute = "/api/browser-import/requests";
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
  return (item?.verb === "MEMBER_VOTEUP_ANSWER" && /^https:\/\/www\.zhihu\.com\/question\/\d+\/answer\/\d+$/u.test(url))
    || (item?.verb === "MEMBER_VOTEUP_ARTICLE" && /^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+$/u.test(url));
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
    const { items, urls, boundary, boundary_reason, pages_read, requested, inventory_sha256 } = await request(
      "/api/social-archive/zhihu/recent-likes", { action: "preview", limit }
    );
    const inventory = { items, urls, boundary, boundary_reason, pages_read, requested, inventory_sha256 };
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

async function verifyBodies(readingRoot, results) {
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
    if (!body || !keys.some(key => aliases.includes(key)) || sha256(data) !== view.hash) {
      throw new Error("standard_import_body_identity_or_hash_mismatch");
    }
    for (const alias of aliases) {
      if (expected.has(alias) && expected.get(alias) !== file) throw new Error("reading_area_duplicate_source_url");
      expected.set(alias, file);
    }
    bodies.push({ url: result.requested_url, path: file, sha256: view.hash, status: result.status, existing_body_reused: reused });
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

export async function runQuickAction(input, { limit, dataRoot, readingRoot, request, waitMs = 3_300_000, pollMs = 4000 }) {
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
  const receiptPath = path.join(runDir, "operation-receipt.json");
  const health = await request("/api/highlights/health");
  if (health.status !== "ok") throw new Error("progressive_reading_service_unavailable");
  const root = await fs.realpath(readingRoot);
  await fs.mkdir(runDir, { recursive: true });
  const inventory = await freezeInventory(request, path.join(runDir, "inventory.json"), limit);
  const clientRequestId = `zhihu-likes-quick-${runId}`;
  const checkpointPath = path.join(runDir, "standard-request.json");
  let submitted = await readJson(checkpointPath);
  let result;
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
    let terminal;
    do {
      terminal = await request(`${importRoute}/${encodeURIComponent(submitted.requestId)}`);
      if (terminal.request_id !== submitted.requestId) throw new Error("standard_import_request_id_mismatch");
      if (terminal.terminal === true) break;
      if (Date.now() < deadline) await delay(pollMs);
    } while (Date.now() < deadline);
    await writeJson(path.join(runDir, "standard-receipt.json"), terminal);

    const byUrl = new Map((terminal.results || []).map(row => [row.requested_url, row]));
    const results = inventory.urls.map(url => byUrl.get(url));
    const complete = terminal.terminal === true && terminal.status === "completed" && terminal.results?.length === limit
      && results.every(row => row && ["imported", "idempotent_replay"].includes(row.status));
    if (complete) {
      const bodies = await verifyBodies(root, results);
      const reused = bodies.filter(row => row.existing_body_reused).length;
      const detail = `已逐条回读最新 ${limit} 条知乎点赞，${limit - reused} 条落入「知乎/知乎点赞」，${reused} 条复用阅读区已有正文。`;
      result = { state: "completed", detail, bodies };
    } else {
      const ready = results.filter(row => row && ["imported", "idempotent_replay"].includes(row.status)).length;
      result = terminal.terminal === true
        ? { state: "failed", detail: `标准导入确认 ${ready}/${limit} 条，状态 ${terminal.status}。回执 ${submitted.requestId}。` }
        : { state: "unknown", detail: `标准导入仍在运行（${ready}/${limit}）。回执 ${submitted.requestId}。` };
    }
  } catch (error) {
    result = { state: "unknown", detail: `导入结果待核对。${error.message}` };
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
