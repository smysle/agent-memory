// AgentMemory — SQLite database initialization and schema
import Database from "better-sqlite3";
import { randomUUID } from "crypto";

export const SCHEMA_VERSION = 8;
const DATABASE_PATHS = new WeakMap<Database.Database, string>();

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
  emotion_tag   TEXT,
  source_session TEXT,
  source_context TEXT,
  observed_at   TEXT,
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
  id           TEXT PRIMARY KEY,
  memory_id    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  provider_id  TEXT NOT NULL,
  vector       BLOB,
  content_hash TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
  created_at   TEXT NOT NULL,
  UNIQUE(memory_id, provider_id)
);

-- Maintenance jobs (reflect / reindex checkpoints)
CREATE TABLE IF NOT EXISTS maintenance_jobs (
  job_id       TEXT PRIMARY KEY,
  phase        TEXT NOT NULL CHECK(phase IN ('decay','tidy','govern','all')),
  status       TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  checkpoint   TEXT,
  error        TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);

-- Feedback signals (recall/surface usefulness + governance priors)
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

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Memory archive (eviction archive)
CREATE TABLE IF NOT EXISTS memory_archive (
  id             TEXT PRIMARY KEY,
  content        TEXT NOT NULL,
  type           TEXT NOT NULL,
  priority       INTEGER NOT NULL,
  emotion_val    REAL NOT NULL DEFAULT 0.0,
  vitality       REAL NOT NULL DEFAULT 0.0,
  stability      REAL NOT NULL DEFAULT 1.0,
  access_count   INTEGER NOT NULL DEFAULT 0,
  last_accessed  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  archived_at    TEXT NOT NULL,
  archive_reason TEXT NOT NULL DEFAULT 'eviction',
  source         TEXT,
  agent_id       TEXT NOT NULL DEFAULT 'default',
  hash           TEXT,
  emotion_tag    TEXT,
  source_session TEXT,
  source_context TEXT,
  observed_at    TEXT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_vitality ON memories(vitality);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(hash);
CREATE INDEX IF NOT EXISTS idx_paths_memory ON paths(memory_id);
CREATE INDEX IF NOT EXISTS idx_paths_domain ON paths(domain);
CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_phase_status ON maintenance_jobs(phase, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_events_memory ON feedback_events(memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_archive_agent ON memory_archive(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_archive_type ON memory_archive(type);
CREATE INDEX IF NOT EXISTS idx_memory_archive_archived_at ON memory_archive(archived_at);
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
  DATABASE_PATHS.set(db, opts.path);

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
  ensureFeedbackEventSchema(db);

  return db;
}

export function getDatabasePath(db: Database.Database): string | null {
  const registered = DATABASE_PATHS.get(db);
  if (registered) return registered;

  const candidate = (db as unknown as { name?: unknown }).name;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
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

function tableExists(db: Database.Database, table: string): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) as { name: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
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
    if (v === 3) {
      migrateV3ToV4(db);
      v = 4;
      continue;
    }
    if (v === 4) {
      migrateV4ToV5(db);
      v = 5;
      continue;
    }
    if (v === 5) {
      migrateV5ToV6(db);
      v = 6;
      continue;
    }
    if (v === 6) {
      migrateV6ToV7(db);
      v = 7;
      continue;
    }
    if (v === 7) {
      migrateV7ToV8(db);
      v = 8;
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
  const hasEmbeddings = tableExists(db, "embeddings");
  const hasV4Embeddings = hasEmbeddings
    && tableHasColumn(db, "embeddings", "provider_id")
    && tableHasColumn(db, "embeddings", "status")
    && tableHasColumn(db, "embeddings", "content_hash")
    && tableHasColumn(db, "embeddings", "id");
  const hasMaintenanceJobs = tableExists(db, "maintenance_jobs");
  const hasFeedbackEvents = tableExists(db, "feedback_events");

  const hasEmotionTag = tableHasColumn(db, "memories", "emotion_tag");
  const hasProvenance = tableHasColumn(db, "memories", "source_session")
    && tableHasColumn(db, "memories", "source_context")
    && tableHasColumn(db, "memories", "observed_at");

  const hasMemoryArchive = tableExists(db, "memory_archive");

  if (hasAgentScopedPaths && hasAgentScopedLinks && hasV4Embeddings && hasMaintenanceJobs && hasFeedbackEvents && hasEmotionTag && hasProvenance && hasMemoryArchive) return 8;
  if (hasAgentScopedPaths && hasAgentScopedLinks && hasV4Embeddings && hasMaintenanceJobs && hasFeedbackEvents && hasEmotionTag && hasProvenance) return 7;
  if (hasAgentScopedPaths && hasAgentScopedLinks && hasV4Embeddings && hasMaintenanceJobs && hasFeedbackEvents && hasEmotionTag) return 6;
  if (hasAgentScopedPaths && hasAgentScopedLinks && hasV4Embeddings && hasMaintenanceJobs && hasFeedbackEvents) return 5;
  if (hasAgentScopedPaths && hasAgentScopedLinks && hasV4Embeddings) return 4;
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
  if (tableExists(db, "embeddings")) {
    if (tableHasColumn(db, "embeddings", "provider_id")) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_provider_status ON embeddings(provider_id, status);");
      db.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_memory_provider ON embeddings(memory_id, provider_id);");
    } else {
      db.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_agent_model ON embeddings(agent_id, model);");
      db.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_memory ON embeddings(memory_id);");
    }
  }
  if (tableExists(db, "maintenance_jobs")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_phase_status ON maintenance_jobs(phase, status, started_at DESC);");
  }
  if (tableHasColumn(db, "memories", "emotion_tag")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_memories_emotion_tag ON memories(emotion_tag) WHERE emotion_tag IS NOT NULL;");
  }
  if (tableHasColumn(db, "memories", "observed_at")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_memories_observed_at ON memories(observed_at) WHERE observed_at IS NOT NULL;");
  }
  // Ensure updated_at index for temporal queries
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);");
  if (tableExists(db, "feedback_events")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_events_memory ON feedback_events(memory_id, created_at DESC);");
    if (tableHasColumn(db, "feedback_events", "agent_id") && tableHasColumn(db, "feedback_events", "source")) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_events_agent_source ON feedback_events(agent_id, source, created_at DESC);");
    }
  }
  if (tableExists(db, "memory_archive")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_archive_agent ON memory_archive(agent_id);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_archive_type ON memory_archive(type);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_archive_archived_at ON memory_archive(archived_at);");
  }
}

function ensureFeedbackEventSchema(db: Database.Database): void {
  if (!tableExists(db, "feedback_events")) return;

  if (!tableHasColumn(db, "feedback_events", "source")) {
    db.exec("ALTER TABLE feedback_events ADD COLUMN source TEXT NOT NULL DEFAULT 'surface';");
  }
  if (!tableHasColumn(db, "feedback_events", "useful")) {
    db.exec("ALTER TABLE feedback_events ADD COLUMN useful INTEGER NOT NULL DEFAULT 1;");
  }
  if (!tableHasColumn(db, "feedback_events", "agent_id")) {
    db.exec("ALTER TABLE feedback_events ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default';");
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_events_agent_source ON feedback_events(agent_id, source, created_at DESC);");
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

function migrateV3ToV4(db: Database.Database): void {
  const alreadyMigrated = tableHasColumn(db, "embeddings", "provider_id")
    && tableHasColumn(db, "embeddings", "status")
    && tableHasColumn(db, "embeddings", "content_hash")
    && tableHasColumn(db, "embeddings", "id");

  if (alreadyMigrated) {
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(4));
    return;
  }

  try {
    db.exec("BEGIN");

    const legacyRows = tableExists(db, "embeddings")
      ? db.prepare(
        `SELECT e.agent_id, e.memory_id, e.model, e.vector, e.created_at, m.hash
         FROM embeddings e
         LEFT JOIN memories m ON m.id = e.memory_id`,
      ).all() as Array<{ agent_id: string; memory_id: string; model: string; vector: Buffer; created_at: string; hash: string | null }>
      : [];

    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings_v4 (
        id           TEXT PRIMARY KEY,
        memory_id    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        provider_id  TEXT NOT NULL,
        vector       BLOB,
        content_hash TEXT NOT NULL,
        status       TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
        created_at   TEXT NOT NULL,
        UNIQUE(memory_id, provider_id)
      );
    `);

    const insert = db.prepare(
      `INSERT INTO embeddings_v4 (id, memory_id, provider_id, vector, content_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'ready', ?)`,
    );

    for (const row of legacyRows) {
      insert.run(newId(), row.memory_id, `legacy:${row.agent_id}:${row.model}`, row.vector, row.hash ?? "", row.created_at);
    }

    if (tableExists(db, "embeddings")) {
      db.exec("DROP TABLE embeddings;");
    }
    db.exec("ALTER TABLE embeddings_v4 RENAME TO embeddings;");

    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(4));
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

function migrateV4ToV5(db: Database.Database): void {
  const hasMaintenanceJobs = tableExists(db, "maintenance_jobs");
  const hasFeedbackEvents = tableExists(db, "feedback_events");

  if (hasMaintenanceJobs && hasFeedbackEvents) {
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(5));
    return;
  }

  try {
    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_jobs (
        job_id       TEXT PRIMARY KEY,
        phase        TEXT NOT NULL CHECK(phase IN ('decay','tidy','govern','all')),
        status       TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
        checkpoint   TEXT,
        error        TEXT,
        started_at   TEXT NOT NULL,
        finished_at  TEXT
      );
    `);
    db.exec(`
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
    `);
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(5));
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

function migrateV5ToV6(db: Database.Database): void {
  // v6 adds emotion_tag column to memories table
  if (tableHasColumn(db, "memories", "emotion_tag")) {
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(6));
    return;
  }

  try {
    db.exec("BEGIN");
    db.exec("ALTER TABLE memories ADD COLUMN emotion_tag TEXT;");
    db.exec("CREATE INDEX IF NOT EXISTS idx_memories_emotion_tag ON memories(emotion_tag) WHERE emotion_tag IS NOT NULL;");
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(6));
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

function migrateV6ToV7(db: Database.Database): void {
  // v7 adds provenance columns: source_session, source_context, observed_at
  const alreadyMigrated = tableHasColumn(db, "memories", "source_session")
    && tableHasColumn(db, "memories", "source_context")
    && tableHasColumn(db, "memories", "observed_at");

  if (alreadyMigrated) {
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(7));
    return;
  }

  try {
    db.exec("BEGIN");
    if (!tableHasColumn(db, "memories", "source_session")) {
      db.exec("ALTER TABLE memories ADD COLUMN source_session TEXT;");
    }
    if (!tableHasColumn(db, "memories", "source_context")) {
      db.exec("ALTER TABLE memories ADD COLUMN source_context TEXT;");
    }
    if (!tableHasColumn(db, "memories", "observed_at")) {
      db.exec("ALTER TABLE memories ADD COLUMN observed_at TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_memories_observed_at ON memories(observed_at) WHERE observed_at IS NOT NULL;");
    db.exec("CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);");
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(7));
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

function migrateV7ToV8(db: Database.Database): void {
  // v8 adds memory_archive table for eviction archiving
  if (tableExists(db, "memory_archive")) {
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(8));
    return;
  }

  try {
    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_archive (
        id             TEXT PRIMARY KEY,
        content        TEXT NOT NULL,
        type           TEXT NOT NULL,
        priority       INTEGER NOT NULL,
        emotion_val    REAL NOT NULL DEFAULT 0.0,
        vitality       REAL NOT NULL DEFAULT 0.0,
        stability      REAL NOT NULL DEFAULT 1.0,
        access_count   INTEGER NOT NULL DEFAULT 0,
        last_accessed  TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        archived_at    TEXT NOT NULL,
        archive_reason TEXT NOT NULL DEFAULT 'eviction',
        source         TEXT,
        agent_id       TEXT NOT NULL DEFAULT 'default',
        hash           TEXT,
        emotion_tag    TEXT,
        source_session TEXT,
        source_context TEXT,
        observed_at    TEXT
      );
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_archive_agent ON memory_archive(agent_id);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_archive_type ON memory_archive(type);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_archive_archived_at ON memory_archive(archived_at);");
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(8));
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}
