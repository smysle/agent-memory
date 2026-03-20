import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/core/db.js";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agent-memory-migration-v8-test.db";

function createV7Database(path: string) {
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
      emotion_tag   TEXT,
      source_session TEXT,
      source_context TEXT,
      observed_at   TEXT,
      UNIQUE(hash, agent_id)
    );

    CREATE TABLE IF NOT EXISTS paths (
      id          TEXT PRIMARY KEY,
      memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      agent_id    TEXT NOT NULL DEFAULT 'default',
      uri         TEXT NOT NULL,
      alias       TEXT,
      domain      TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE(agent_id, uri)
    );

    CREATE TABLE IF NOT EXISTS links (
      agent_id    TEXT NOT NULL DEFAULT 'default',
      source_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation    TEXT NOT NULL,
      weight      REAL NOT NULL DEFAULT 1.0,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (agent_id, source_id, target_id)
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

    CREATE TABLE IF NOT EXISTS embeddings (
      id           TEXT PRIMARY KEY,
      memory_id    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      provider_id  TEXT NOT NULL,
      vector       BLOB,
      content_hash TEXT NOT NULL,
      status       TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
      created_at   TEXT NOT NULL,
      UNIQUE(memory_id, provider_id)
    );

    CREATE TABLE IF NOT EXISTS maintenance_jobs (
      job_id       TEXT PRIMARY KEY,
      phase        TEXT NOT NULL CHECK(phase IN ('decay','tidy','govern','all')),
      status       TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
      checkpoint   TEXT,
      error        TEXT,
      started_at   TEXT NOT NULL,
      finished_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS feedback_events (
      id           TEXT PRIMARY KEY,
      memory_id    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      source       TEXT NOT NULL DEFAULT 'surface',
      useful       INTEGER NOT NULL DEFAULT 1,
      agent_id     TEXT NOT NULL DEFAULT 'default',
      event_type   TEXT NOT NULL DEFAULT 'surface:useful',
      value        REAL NOT NULL DEFAULT 1.0,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '7');
  `);

  return db;
}

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(TEST_DB + suffix); } catch {}
  }
});

describe("Schema migration v7 → v8", () => {
  it("creates memory_archive table on migration", () => {
    const v7 = createV7Database(TEST_DB);

    // Insert a test memory
    const ts = new Date().toISOString();
    v7.prepare(`INSERT INTO memories (id, content, type, priority, emotion_val, vitality, stability, access_count, created_at, updated_at, agent_id, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "test-mem", "Test memory content", "knowledge", 2, 0, 1, 90, 0, ts, ts, "default", "hash-test",
    );
    v7.close();

    // Open with new schema — should migrate
    const db = openDatabase({ path: TEST_DB });

    // Verify version
    const version = (db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string }).value;
    expect(version).toBe("8");

    // Verify memory_archive table exists
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_archive'").get() as { name: string } | undefined;
    expect(table?.name).toBe("memory_archive");

    // Verify columns
    const cols = db.prepare("PRAGMA table_info(memory_archive)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("content");
    expect(colNames).toContain("archived_at");
    expect(colNames).toContain("archive_reason");
    expect(colNames).toContain("emotion_tag");
    expect(colNames).toContain("source_session");
    expect(colNames).toContain("source_context");
    expect(colNames).toContain("observed_at");

    // Verify existing memory is still intact
    const mem = db.prepare("SELECT * FROM memories WHERE id = ?").get("test-mem") as { content: string };
    expect(mem.content).toBe("Test memory content");

    // Verify indexes exist
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_archive'").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_memory_archive_agent");
    expect(indexNames).toContain("idx_memory_archive_type");
    expect(indexNames).toContain("idx_memory_archive_archived_at");

    db.close();
  });

  it("idempotent migration (already at v8)", () => {
    // Create v7 and migrate once
    const v7 = createV7Database(TEST_DB);
    v7.close();
    const db1 = openDatabase({ path: TEST_DB });
    const v1 = (db1.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string }).value;
    expect(v1).toBe("8");
    db1.close();

    // Open again — should not fail
    const db2 = openDatabase({ path: TEST_DB });
    const v2 = (db2.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string }).value;
    expect(v2).toBe("8");
    db2.close();
  });
});
