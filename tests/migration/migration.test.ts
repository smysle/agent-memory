import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/core/db.js";
import { createMemory } from "../../src/core/memory.js";
import { createPath, getPathByUri } from "../../src/core/path.js";
import { getLinks } from "../../src/core/link.js";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agent-memory-migration-test.db";

function createV1Database(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id            TEXT PRIMARY KEY,
      content       TEXT NOT NULL,
      type          TEXT NOT NULL CHECK(type IN ('identity','emotion','knowledge','event')),
      priority      INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 3),
      emotion_val   REAL NOT NULL DEFAULT 0.0,
      vitality      REAL NOT NULL DEFAULT 1.0,
      stability     REAL NOT NULL DEFAULT 1.0,
      access_count  INTEGER NOT NULL DEFAULT 0,
      last_accessed TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      source        TEXT,
      agent_id      TEXT NOT NULL DEFAULT 'default',
      hash          TEXT,
      UNIQUE(hash, agent_id)
    );

    CREATE TABLE IF NOT EXISTS paths (
      id          TEXT PRIMARY KEY,
      memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      uri         TEXT NOT NULL UNIQUE,
      alias       TEXT,
      domain      TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS links (
      source_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation    TEXT NOT NULL,
      weight      REAL NOT NULL DEFAULT 1.0,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (source_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id          TEXT PRIMARY KEY,
      memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      content     TEXT NOT NULL,
      changed_by  TEXT,
      action      TEXT NOT NULL CHECK(action IN ('create','update','delete','merge')),
      created_at  TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      content,
      tokenize='unicode61'
    );

    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '1');
  `);

  return db;
}

afterEach(() => {
  [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"].forEach((f) => { try { unlinkSync(f); } catch {} });
});

describe("Schema migration", () => {
  it("migrates v1 paths/links to v2 agent-scoped tables", () => {
    const v1 = createV1Database(TEST_DB);

    const a = createMemory(v1 as any, { content: "A", type: "identity", agent_id: "agent-a" })!;
    const b = createMemory(v1 as any, { content: "B", type: "identity", agent_id: "agent-b" })!;

    v1.prepare("INSERT INTO paths (id, memory_id, uri, alias, domain, created_at) VALUES (?,?,?,?,?,?)").run(
      "p1",
      a.id,
      "core://user/name",
      null,
      "core",
      new Date().toISOString(),
    );

    // Cross-agent link was possible in v1; should be removed during migration.
    v1.prepare("INSERT INTO links (source_id, target_id, relation, weight, created_at) VALUES (?,?,?,?,?)").run(
      a.id,
      b.id,
      "related",
      1.0,
      new Date().toISOString(),
    );

    v1.close();

    const db = openDatabase({ path: TEST_DB });

    const version = (db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined)?.value;
    expect(version).toBe("3");
    const embeddingsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'").get() as { name: string } | undefined;
    expect(Boolean(embeddingsTable?.name)).toBe(true);

    const cols = db.prepare("PRAGMA table_info(paths)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "agent_id")).toBe(true);

    const migratedPath = getPathByUri(db, "core://user/name", "agent-a");
    expect(migratedPath?.agent_id).toBe("agent-a");
    expect(migratedPath?.memory_id).toBe(a.id);

    const links = getLinks(db, a.id, "agent-a");
    expect(links).toHaveLength(0);

    // After v2 migration, two agents can share the same URI without conflict.
    createPath(db, b.id, "core://user/name");
    const bPath = getPathByUri(db, "core://user/name", "agent-b");
    expect(bPath?.memory_id).toBe(b.id);

    db.close();
  });
});
