import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/core/db.js";
import { createMemory } from "../../src/core/memory.js";
import { createPath, getPathByUri } from "../../src/core/path.js";
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
  it("migrates v1 paths/links to v4 schema while preserving compatibility", () => {
    const v1 = createV1Database(TEST_DB);

    // Insert directly using SQL since v1 schema doesn't have emotion_tag column
    const ts = new Date().toISOString();
    v1.prepare(`INSERT INTO memories (id, content, type, priority, emotion_val, vitality, stability, access_count, created_at, updated_at, agent_id, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("a1", "A", "identity", 0, 0, 1, 999999, 0, ts, ts, "agent-a", "hash-a");
    v1.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run("a1", "A");
    v1.prepare(`INSERT INTO memories (id, content, type, priority, emotion_val, vitality, stability, access_count, created_at, updated_at, agent_id, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("b1", "B", "identity", 0, 0, 1, 999999, 0, ts, ts, "agent-b", "hash-b");
    v1.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run("b1", "B");
    const a = { id: "a1" };
    const b = { id: "b1" };;

    v1.prepare("INSERT INTO paths (id, memory_id, uri, alias, domain, created_at) VALUES (?,?,?,?,?,?)").run(
      "p1",
      a.id,
      "core://user/name",
      null,
      "core",
      new Date().toISOString(),
    );

    // Cross-agent link was possible in v1; migration should remove incompatible links.
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
    expect(version).toBe("6");

    // v6: emotion_tag column exists
    const memoryCols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    expect(memoryCols.some((c) => c.name === "emotion_tag")).toBe(true);

    const embeddingsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'").get() as { name: string } | undefined;
    const maintenanceJobsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='maintenance_jobs'").get() as { name: string } | undefined;
    const feedbackEventsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_events'").get() as { name: string } | undefined;
    const linksTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='links'").get() as { name: string } | undefined;
    const snapshotsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'").get() as { name: string } | undefined;
    expect(Boolean(embeddingsTable?.name)).toBe(true);
    expect(Boolean(maintenanceJobsTable?.name)).toBe(true);
    expect(Boolean(feedbackEventsTable?.name)).toBe(true);
    expect(Boolean(linksTable?.name)).toBe(true);
    expect(Boolean(snapshotsTable?.name)).toBe(true);

    const cols = db.prepare("PRAGMA table_info(paths)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "agent_id")).toBe(true);

    const embeddingCols = db.prepare("PRAGMA table_info(embeddings)").all() as Array<{ name: string }>;
    expect(embeddingCols.some((c) => c.name === "provider_id")).toBe(true);
    expect(embeddingCols.some((c) => c.name === "status")).toBe(true);

    const migratedPath = getPathByUri(db, "core://user/name", "agent-a");
    expect(migratedPath?.agent_id).toBe("agent-a");
    expect(migratedPath?.memory_id).toBe(a.id);

    const linksRemaining = (db.prepare("SELECT COUNT(*) as c FROM links").get() as { c: number }).c;
    expect(linksRemaining).toBe(0);

    // After v2+ migration, two agents can share the same URI without conflict.
    createPath(db, b.id, "core://user/name");
    const bPath = getPathByUri(db, "core://user/name", "agent-b");
    expect(bPath?.memory_id).toBe(b.id);

    db.close();
  });
});
