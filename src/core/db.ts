// AgentMemory v2 — SQLite database initialization and schema
import Database from "better-sqlite3";
import { randomUUID } from "crypto";

export const SCHEMA_VERSION = 3;

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
  agent_id    TEXT NOT NULL DEFAULT 'default',
  uri         TEXT NOT NULL,
  alias       TEXT,
  domain      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(agent_id, uri)
);

-- Association network (knowledge graph)
CREATE TABLE IF NOT EXISTS links (
  agent_id    TEXT NOT NULL DEFAULT 'default',
  source_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (agent_id, source_id, target_id)
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

-- Embeddings (optional semantic layer)
CREATE TABLE IF NOT EXISTS embeddings (
  agent_id    TEXT NOT NULL DEFAULT 'default',
  memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vector      BLOB NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (agent_id, memory_id, model)
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

  // Track schema version and migrate forward if needed
  const currentVersion = getSchemaVersion(db);
  if (currentVersion === null) {
    const inferred = inferSchemaVersion(db);
    if (inferred < SCHEMA_VERSION) {
      migrateDatabase(db, inferred, SCHEMA_VERSION);
    }
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(SCHEMA_VERSION));
  } else if (currentVersion < SCHEMA_VERSION) {
    migrateDatabase(db, currentVersion, SCHEMA_VERSION);
  }

  ensureIndexes(db);

  return db;
}

export function now(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

function getSchemaVersion(db: Database.Database): number | null {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    if (!row) return null;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  } catch {
    return false;
  }
}

function migrateDatabase(db: Database.Database, from: number, to: number): void {
  let v = from;
  while (v < to) {
    if (v === 1) {
      migrateV1ToV2(db);
      v = 2;
      continue;
    }
    if (v === 2) {
      migrateV2ToV3(db);
      v = 3;
      continue;
    }
    throw new Error(`Unsupported schema migration path: v${from} → v${to} (stuck at v${v})`);
  }
}

function migrateV1ToV2(db: Database.Database): void {
  // v2 introduces agent-scoped paths and links.
  // We rebuild both tables to add agent_id and adjust uniqueness/primary keys.
  const pathsMigrated = tableHasColumn(db, "paths", "agent_id");
  const linksMigrated = tableHasColumn(db, "links", "agent_id");
  const alreadyMigrated = pathsMigrated && linksMigrated;
  if (alreadyMigrated) {
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(2));
    return;
  }

  db.pragma("foreign_keys = OFF");
  try {
    db.exec("BEGIN");

    // ---- paths ----
    if (!pathsMigrated) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS paths_v2 (
          id          TEXT PRIMARY KEY,
          memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          agent_id    TEXT NOT NULL DEFAULT 'default',
          uri         TEXT NOT NULL,
          alias       TEXT,
          domain      TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          UNIQUE(agent_id, uri)
        );
      `);

      // Derive agent_id from the referenced memory (fallback to 'default' for orphans).
      db.exec(`
        INSERT INTO paths_v2 (id, memory_id, agent_id, uri, alias, domain, created_at)
        SELECT p.id, p.memory_id, COALESCE(m.agent_id, 'default'), p.uri, p.alias, p.domain, p.created_at
        FROM paths p
        LEFT JOIN memories m ON m.id = p.memory_id;
      `);

      db.exec("DROP TABLE paths;");
      db.exec("ALTER TABLE paths_v2 RENAME TO paths;");
    }

    // ---- links ----
    if (!linksMigrated) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS links_v2 (
          agent_id    TEXT NOT NULL DEFAULT 'default',
          source_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          target_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          relation    TEXT NOT NULL,
          weight      REAL NOT NULL DEFAULT 1.0,
          created_at  TEXT NOT NULL,
          PRIMARY KEY (agent_id, source_id, target_id)
        );
      `);

      // Derive agent_id from source memory; delete links where source/target agent mismatch after migration.
      db.exec(`
        INSERT INTO links_v2 (agent_id, source_id, target_id, relation, weight, created_at)
        SELECT COALESCE(ms.agent_id, 'default'), l.source_id, l.target_id, l.relation, l.weight, l.created_at
        FROM links l
        LEFT JOIN memories ms ON ms.id = l.source_id;
      `);

      // Remove cross-agent links (cannot be represented safely in v2 semantics).
      db.exec(`
        DELETE FROM links_v2
        WHERE EXISTS (SELECT 1 FROM memories s WHERE s.id = links_v2.source_id AND s.agent_id != links_v2.agent_id)
           OR EXISTS (SELECT 1 FROM memories t WHERE t.id = links_v2.target_id AND t.agent_id != links_v2.agent_id);
      `);

      db.exec("DROP TABLE links;");
      db.exec("ALTER TABLE links_v2 RENAME TO links;");
    }

    // Recreate indexes that were dropped with the old tables.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_paths_memory ON paths(memory_id);
      CREATE INDEX IF NOT EXISTS idx_paths_domain ON paths(domain);
    `);

    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(2));
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function inferSchemaVersion(db: Database.Database): number {
  // Best-effort inference for databases created without schema_meta.
  const hasAgentScopedPaths = tableHasColumn(db, "paths", "agent_id");
  const hasAgentScopedLinks = tableHasColumn(db, "links", "agent_id");
  const hasEmbeddings = (() => {
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'").get() as { name: string } | undefined;
      return Boolean(row);
    } catch {
      return false;
    }
  })();
  if (hasAgentScopedPaths && hasAgentScopedLinks && hasEmbeddings) return 3;
  if (hasAgentScopedPaths && hasAgentScopedLinks) return 2;
  return 1;
}

function ensureIndexes(db: Database.Database): void {
  // Indexes that depend on newer columns must be created conditionally.
  if (tableHasColumn(db, "paths", "agent_id")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_paths_agent_uri ON paths(agent_id, uri);");
  }
  if (tableHasColumn(db, "links", "agent_id")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_links_agent_source ON links(agent_id, source_id);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_links_agent_target ON links(agent_id, target_id);");
  }
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'").get() as { name: string } | undefined;
    if (row) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_agent_model ON embeddings(agent_id, model);");
      db.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_memory ON embeddings(memory_id);");
    }
  } catch {
    // ignore
  }
}

function migrateV2ToV3(db: Database.Database): void {
  // v3 introduces embeddings table for optional semantic search.
  // Safe additive migration.
  try {
    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        agent_id    TEXT NOT NULL DEFAULT 'default',
        memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        model       TEXT NOT NULL,
        dim         INTEGER NOT NULL,
        vector      BLOB NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (agent_id, memory_id, model)
      );
    `);
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(3));
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}
