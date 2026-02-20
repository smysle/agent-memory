// AgentMemory v2 — SQLite database initialization and schema
import Database from "better-sqlite3";
import { randomUUID } from "crypto";

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
-- Memory entries
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

-- URI paths (Content-Path separation, from nocturne)
CREATE TABLE IF NOT EXISTS paths (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  uri         TEXT NOT NULL UNIQUE,
  alias       TEXT,
  domain      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Association network (knowledge graph)
CREATE TABLE IF NOT EXISTS links (
  source_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id)
);

-- Snapshots (version control, from nocturne + Memory Palace)
CREATE TABLE IF NOT EXISTS snapshots (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  changed_by  TEXT,
  action      TEXT NOT NULL CHECK(action IN ('create','update','delete','merge')),
  created_at  TEXT NOT NULL
);

-- Full-text search index (BM25)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  content,
  tokenize='unicode61'
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_vitality ON memories(vitality);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(hash);
CREATE INDEX IF NOT EXISTS idx_paths_memory ON paths(memory_id);
CREATE INDEX IF NOT EXISTS idx_paths_domain ON paths(domain);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_id);
`;

export interface DbOptions {
  path: string;
  walMode?: boolean;
}

/**
 * Type guard for SQLite count query results.
 * Validates that a row has a numeric 'c' property.
 */
export function isCountRow(row: unknown): row is { c: number } {
  return row !== null && typeof row === "object" && "c" in (row as Record<string, unknown>) && typeof (row as Record<string, unknown>).c === "number";
}

export function openDatabase(opts: DbOptions): Database.Database {
  const db = new Database(opts.path);

  // Enable WAL mode for better concurrent read performance
  if (opts.walMode !== false) {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // Run schema creation
  db.exec(SCHEMA_SQL);

  // Track schema version
  const getVersion = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'");
  const row = getVersion.get() as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(
      String(SCHEMA_VERSION),
    );
  }

  return db;
}

export function now(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}
