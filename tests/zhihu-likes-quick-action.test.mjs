import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runQuickAction } from "../scripts/zhihu-likes-quick-action.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-zhihu-likes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const readingRoot = path.join(root, "reading");
  const outputDir = path.join(readingRoot, "知乎", "知乎点赞");
  const existingDir = path.join(readingRoot, "收藏夹");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(existingDir);
  const article = (id, time) => ({ verb: "MEMBER_VOTEUP_ARTICLE", source_url: `https://zhuanlan.zhihu.com/p/${id}`, created_time: time });
  const items = [article(9001, 100), article(9002, 90)];
  const urls = items.map(row => row.source_url);
  const inventory = { items, urls, inventory_sha256: digest(JSON.stringify(items)), requested: 2, boundary: article(9003, 80) };
  const input = { operationId: "voice:independent-fixture", text: "", fields: {} };
  const markdown = url => `---\nsource_url: ${JSON.stringify(url)}\n---\n\n# 正文\n\n测试正文。\n`;
  const results = await Promise.all(urls.map(async (url, index) => {
    const file = path.join(index === 0 ? outputDir : existingDir, `fixture-${index}.md`);
    await fs.writeFile(file, markdown(url));
    return {
      requested_url: url, status: index === 0 ? "imported" : "idempotent_replay",
      artifacts: [{ kind: "markdown", path: file, sha256: digest(markdown(url)) }],
      receipt: { processing_mode: "standard_preprocess", quality_status: "ready", preprocess_status: "completed",
        existing_article_preserved: index !== 0 }
    };
  }));
  const calls = [];
  const terminal = { request_id: "fixture-request", terminal: true, status: "completed", results };
  const run = (operation = input) => runQuickAction(operation, {
    dataRoot: root, readingRoot, limit: 2, waitMs: 0,
    request: async (route, body) => {
      calls.push({ route, body });
      switch (route) {
        case "/api/highlights/health": return { status: "ok" };
        case "/api/social-archive/zhihu/recent-likes":
          assert.deepEqual(body, { action: "preview", limit: 2 });
          return inventory;
        case "/api/browser-import/requests":
          assert.deepEqual(body.urls, urls);
          assert.equal(body.destination_folder, "知乎/知乎点赞");
          assert.match(body.client_request_id, /zhihu-likes-quick-[a-f0-9]{64}$/u);
          return { request_id: terminal.request_id };
        case `/api/browser-import/requests/${terminal.request_id}`: return terminal;
        default: throw new Error(`unexpected_route:${route}`);
      }
    }
  });
  return { run, calls, input, inventory, terminal, duplicate: path.join(existingDir, "duplicate.md"), markdown };
}

test("imports and verifies the frozen latest likes and resumes by operation ID", async t => {
  const { run, calls, inventory } = await fixture(t);
  const first = await run();
  assert.equal(first.state, "completed");
  assert.match(first.detail, /1 条落入.*1 条复用/u);
  inventory.boundary = null;
  assert.deepEqual(await run(), first);
  assert.equal(calls.filter(call => call.body).length, 2);
});

test("rejects a non-like activity in the boundary before submission", async t => {
  const { run, calls, inventory } = await fixture(t);
  inventory.boundary.verb = "MEMBER_CREATE_ARTICLE";
  await assert.rejects(run(), /boundary_unverified/u);
  assert.equal(calls.filter(call => call.body).length, 1);
});

test("rejects duplicate bodies and performs no second submission", async t => {
  const { run, calls, duplicate, markdown, inventory } = await fixture(t);
  await fs.writeFile(duplicate, markdown(inventory.urls[0]));
  const result = await run();
  assert.equal(result.state, "unknown");
  assert.match(result.detail, /duplicate_source_url/u);
  assert.equal(calls.filter(call => call.route === "/api/browser-import/requests").length, 1);
});

test("treats degraded or unfinished receipts as incomplete", async t => {
  const { run, calls, terminal } = await fixture(t);
  terminal.terminal = false;
  terminal.status = "processing";
  terminal.results[0].status = "claimed";
  assert.equal((await run()).state, "unknown");
  terminal.terminal = true;
  terminal.status = "completed_with_degradations";
  terminal.results[0].status = "requires_browser_auth";
  assert.equal((await run()).state, "failed");
  assert.equal(calls.filter(call => call.route === "/api/browser-import/requests").length, 1);
});

test("rejects fields in the no-input shortcut", async t => {
  const { run, calls, input } = await fixture(t);
  assert.equal((await run({ ...input, fields: { limit: 100 } })).state, "failed");
  assert.equal(calls.length, 0);
});
