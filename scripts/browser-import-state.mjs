import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const IMPORT_STATE_SCHEMA = "local-ir.browser-import-broker/v1";
const DATABASE_VERSION = 1;
const databasePath = root => path.join(root, "state.sqlite3");

function transaction(db, begin, operation) {
  db.exec(begin);
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { }
    throw error;
  }
}

function version(db) {
  const value = db.prepare("PRAGMA user_version").get().user_version;
  if (value !== 0 && value !== DATABASE_VERSION) throw new Error("unsupported_browser_import_database_version");
  return value;
}

function writeRows(db, { requests = [], tasks = [], removedRequestIds = [] }) {
  if (removedRequestIds.length) {
    const remove = db.prepare("DELETE FROM requests WHERE id = ?");
    for (const id of removedRequestIds) remove.run(id);
  }
  const writeRequest = db.prepare(`INSERT INTO requests (id, data) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data`);
  for (const request of requests) writeRequest.run(request.id, JSON.stringify(request));
  const writeTask = db.prepare(`INSERT INTO tasks (id, request_id, status, data) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`);
  for (const task of tasks) writeTask.run(task.id, task.requestId, task.status, JSON.stringify(task));
}

function withWriter(root, operation) {
  const db = new DatabaseSync(databasePath(root), { timeout: 5000 });
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
    return operation(db);
  } finally {
    db.close();
  }
}

async function readState(root, readDatabase, readLegacy) {
  const dbPath = databasePath(root);
  const databaseExists = await fs.stat(dbPath).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (databaseExists) {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    try {
      if (version(db) === DATABASE_VERSION) return { value: readDatabase(db), migrated: true };
    } finally {
      db.close();
    }
  }
  const legacy = await fs.readFile(path.join(root, "state.json"), "utf8").then(JSON.parse, error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (legacy !== null && (legacy.schema !== IMPORT_STATE_SCHEMA || !Array.isArray(legacy.requests) || !Array.isArray(legacy.tasks))) {
    throw new Error("invalid_legacy_browser_import_state");
  }
  return { value: readLegacy(legacy || { schema: IMPORT_STATE_SCHEMA, requests: [], tasks: [] }), migrated: false };
}

export function readBrowserImportState(root) {
  return readState(root, db => transaction(db, "BEGIN", () => ({
    schema: IMPORT_STATE_SCHEMA,
    requests: Array.from(db.prepare("SELECT data FROM requests ORDER BY rowid").iterate(), row => JSON.parse(row.data)),
    tasks: Array.from(db.prepare("SELECT data FROM tasks ORDER BY rowid").iterate(), row => JSON.parse(row.data))
  })), state => state);
}

export async function countActiveBrowserImports(root) {
  const { value } = await readState(root,
    db => db.prepare("SELECT count(*) AS count FROM tasks WHERE status IN ('queued', 'claimed')").get().count,
    state => state.tasks.filter(task => task.status === "queued" || task.status === "claimed").length);
  return value;
}

export async function canResumeSiteDiscoveryOnReload(root, runId) {
  const { value: active } = await readState(root,
    db => db.prepare("SELECT data FROM tasks WHERE status IN ('queued', 'claimed') LIMIT 2").all().map(row=>JSON.parse(row.data)),
    state => state.tasks.filter(task=>task.status==='queued'||task.status==='claimed').slice(0,2));
  const [task] = active;
  const collection = task?.result?.collection;
  return active.length===1 && task.status==='claimed' && task.siteImport?.run_id===runId
    && /^local-background-url-fetcher-/u.test(task.workerId||'')
    && collection?.phase==='discovering' && collection.discovery?.phase==='discovering'
    && !collection.inventory && !collection.batches?.length;
}

export function migrateBrowserImportState(root, state) {
  return withWriter(root, db => {
    db.exec("PRAGMA journal_mode = WAL");
    return transaction(db, "BEGIN IMMEDIATE", () => {
      if (version(db) === DATABASE_VERSION) return false;
      db.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
        CREATE TABLE tasks (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
          status TEXT NOT NULL, data TEXT NOT NULL) STRICT;
        CREATE INDEX tasks_request_id ON tasks(request_id);`);
      writeRows(db, state);
      db.exec(`PRAGMA user_version = ${DATABASE_VERSION}`);
      return true;
    });
  });
}

export function saveBrowserImportState(root, changes) {
  withWriter(root, db => transaction(db, "BEGIN IMMEDIATE", () => writeRows(db, changes)));
}
