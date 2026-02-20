// AgentMemory v2 — Sleep-cycle memory for AI agents

// src/core/db.ts
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
var SCHEMA_VERSION = 1;
var SCHEMA_SQL = `
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
function openDatabase(opts) {
  const db = new Database(opts.path);
  if (opts.walMode !== false) {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  const getVersion = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'");
  const row = getVersion.get();
  if (!row) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(
      String(SCHEMA_VERSION)
    );
  }
  return db;
}
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId() {
  return randomUUID();
}

// src/core/memory.ts
import { createHash } from "crypto";
function contentHash(content) {
  return createHash("sha256").update(content.trim()).digest("hex").slice(0, 16);
}
var TYPE_PRIORITY = {
  identity: 0,
  emotion: 1,
  knowledge: 2,
  event: 3
};
var PRIORITY_STABILITY = {
  0: Infinity,
  // P0: never decays
  1: 365,
  // P1: 365-day half-life
  2: 90,
  // P2: 90-day half-life
  3: 14
  // P3: 14-day half-life
};
function createMemory(db, input) {
  const hash = contentHash(input.content);
  const agentId = input.agent_id ?? "default";
  const priority = input.priority ?? TYPE_PRIORITY[input.type];
  const stability = PRIORITY_STABILITY[priority];
  const existing = db.prepare("SELECT id FROM memories WHERE hash = ? AND agent_id = ?").get(hash, agentId);
  if (existing) {
    return null;
  }
  const id = newId();
  const timestamp = now();
  db.prepare(
    `INSERT INTO memories (id, content, type, priority, emotion_val, vitality, stability,
     access_count, created_at, updated_at, source, agent_id, hash)
     VALUES (?, ?, ?, ?, ?, 1.0, ?, 0, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.content,
    input.type,
    priority,
    input.emotion_val ?? 0,
    stability === Infinity ? 999999 : stability,
    timestamp,
    timestamp,
    input.source ?? null,
    agentId,
    hash
  );
  db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run(id, input.content);
  return getMemory(db, id);
}
function getMemory(db, id) {
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) ?? null;
}
function updateMemory(db, id, input) {
  const existing = getMemory(db, id);
  if (!existing) return null;
  const fields = [];
  const values = [];
  if (input.content !== void 0) {
    fields.push("content = ?", "hash = ?");
    values.push(input.content, contentHash(input.content));
  }
  if (input.type !== void 0) {
    fields.push("type = ?");
    values.push(input.type);
  }
  if (input.priority !== void 0) {
    fields.push("priority = ?");
    values.push(input.priority);
  }
  if (input.emotion_val !== void 0) {
    fields.push("emotion_val = ?");
    values.push(input.emotion_val);
  }
  if (input.vitality !== void 0) {
    fields.push("vitality = ?");
    values.push(input.vitality);
  }
  if (input.stability !== void 0) {
    fields.push("stability = ?");
    values.push(input.stability);
  }
  if (input.source !== void 0) {
    fields.push("source = ?");
    values.push(input.source);
  }
  fields.push("updated_at = ?");
  values.push(now());
  values.push(id);
  db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  if (input.content !== void 0) {
    db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
    db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run(id, input.content);
  }
  return getMemory(db, id);
}
function deleteMemory(db, id) {
  db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
  const result = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return result.changes > 0;
}
function listMemories(db, opts) {
  const conditions = [];
  const params = [];
  if (opts?.agent_id) {
    conditions.push("agent_id = ?");
    params.push(opts.agent_id);
  }
  if (opts?.type) {
    conditions.push("type = ?");
    params.push(opts.type);
  }
  if (opts?.priority !== void 0) {
    conditions.push("priority = ?");
    params.push(opts.priority);
  }
  if (opts?.min_vitality !== void 0) {
    conditions.push("vitality >= ?");
    params.push(opts.min_vitality);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;
  return db.prepare(`SELECT * FROM memories ${where} ORDER BY priority ASC, updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
}
function recordAccess(db, id, growthFactor = 1.5) {
  const mem = getMemory(db, id);
  if (!mem) return;
  const newStability = Math.min(999999, mem.stability * growthFactor);
  db.prepare(
    `UPDATE memories SET access_count = access_count + 1, last_accessed = ?, stability = ?,
     vitality = MIN(1.0, vitality * 1.2) WHERE id = ?`
  ).run(now(), newStability, id);
}
function countMemories(db, agent_id = "default") {
  const total = db.prepare("SELECT COUNT(*) as c FROM memories WHERE agent_id = ?").get(agent_id).c;
  const byType = db.prepare("SELECT type, COUNT(*) as c FROM memories WHERE agent_id = ? GROUP BY type").all(agent_id);
  const byPriority = db.prepare("SELECT priority, COUNT(*) as c FROM memories WHERE agent_id = ? GROUP BY priority").all(agent_id);
  return {
    total,
    by_type: Object.fromEntries(byType.map((r) => [r.type, r.c])),
    by_priority: Object.fromEntries(byPriority.map((r) => [`P${r.priority}`, r.c]))
  };
}

// src/core/path.ts
var DEFAULT_DOMAINS = /* @__PURE__ */ new Set(["core", "emotion", "knowledge", "event", "system"]);
function parseUri(uri) {
  const match = uri.match(/^([a-z]+):\/\/(.+)$/);
  if (!match) throw new Error(`Invalid URI: ${uri}. Expected format: domain://path`);
  return { domain: match[1], path: match[2] };
}
function createPath(db, memoryId, uri, alias, validDomains) {
  const { domain } = parseUri(uri);
  const domains = validDomains ?? DEFAULT_DOMAINS;
  if (!domains.has(domain)) {
    throw new Error(`Invalid domain "${domain}". Valid: ${[...domains].join(", ")}`);
  }
  const existing = db.prepare("SELECT id FROM paths WHERE uri = ?").get(uri);
  if (existing) {
    throw new Error(`URI already exists: ${uri}`);
  }
  const id = newId();
  db.prepare(
    "INSERT INTO paths (id, memory_id, uri, alias, domain, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, memoryId, uri, alias ?? null, domain, now());
  return getPath(db, id);
}
function getPath(db, id) {
  return db.prepare("SELECT * FROM paths WHERE id = ?").get(id) ?? null;
}
function getPathByUri(db, uri) {
  return db.prepare("SELECT * FROM paths WHERE uri = ?").get(uri) ?? null;
}
function getPathsByMemory(db, memoryId) {
  return db.prepare("SELECT * FROM paths WHERE memory_id = ?").all(memoryId);
}
function getPathsByDomain(db, domain) {
  return db.prepare("SELECT * FROM paths WHERE domain = ? ORDER BY uri").all(domain);
}
function getPathsByPrefix(db, prefix) {
  return db.prepare("SELECT * FROM paths WHERE uri LIKE ? ORDER BY uri").all(`${prefix}%`);
}
function deletePath(db, id) {
  const result = db.prepare("DELETE FROM paths WHERE id = ?").run(id);
  return result.changes > 0;
}

// src/core/link.ts
function createLink(db, sourceId, targetId, relation, weight = 1) {
  db.prepare(
    `INSERT OR REPLACE INTO links (source_id, target_id, relation, weight, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sourceId, targetId, relation, weight, now());
  return { source_id: sourceId, target_id: targetId, relation, weight, created_at: now() };
}
function getLinks(db, memoryId) {
  return db.prepare("SELECT * FROM links WHERE source_id = ? OR target_id = ?").all(memoryId, memoryId);
}
function getOutgoingLinks(db, sourceId) {
  return db.prepare("SELECT * FROM links WHERE source_id = ?").all(sourceId);
}
function traverse(db, startId, maxHops = 2) {
  const visited = /* @__PURE__ */ new Set();
  const results = [];
  const queue = [
    { id: startId, hop: 0, relation: "self" }
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.hop > 0) {
      results.push(current);
    }
    if (current.hop < maxHops) {
      const links = db.prepare("SELECT target_id, relation FROM links WHERE source_id = ?").all(current.id);
      for (const link of links) {
        if (!visited.has(link.target_id)) {
          queue.push({
            id: link.target_id,
            hop: current.hop + 1,
            relation: link.relation
          });
        }
      }
      const reverseLinks = db.prepare("SELECT source_id, relation FROM links WHERE target_id = ?").all(current.id);
      for (const link of reverseLinks) {
        if (!visited.has(link.source_id)) {
          queue.push({
            id: link.source_id,
            hop: current.hop + 1,
            relation: link.relation
          });
        }
      }
    }
  }
  return results;
}
function deleteLink(db, sourceId, targetId) {
  const result = db.prepare("DELETE FROM links WHERE source_id = ? AND target_id = ?").run(sourceId, targetId);
  return result.changes > 0;
}

// src/core/snapshot.ts
function createSnapshot(db, memoryId, action, changedBy) {
  const memory = db.prepare("SELECT content FROM memories WHERE id = ?").get(memoryId);
  if (!memory) throw new Error(`Memory not found: ${memoryId}`);
  const id = newId();
  db.prepare(
    `INSERT INTO snapshots (id, memory_id, content, changed_by, action, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, memoryId, memory.content, changedBy ?? null, action, now());
  return { id, memory_id: memoryId, content: memory.content, changed_by: changedBy ?? null, action, created_at: now() };
}
function getSnapshots(db, memoryId) {
  return db.prepare("SELECT * FROM snapshots WHERE memory_id = ? ORDER BY created_at DESC").all(memoryId);
}
function getSnapshot(db, id) {
  return db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) ?? null;
}
function rollback(db, snapshotId) {
  const snapshot = getSnapshot(db, snapshotId);
  if (!snapshot) return false;
  createSnapshot(db, snapshot.memory_id, "update", "rollback");
  db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?").run(
    snapshot.content,
    now(),
    snapshot.memory_id
  );
  db.prepare("DELETE FROM memories_fts WHERE id = ?").run(snapshot.memory_id);
  db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run(
    snapshot.memory_id,
    snapshot.content
  );
  return true;
}

// src/core/guard.ts
function guard(db, input) {
  const hash = contentHash(input.content);
  const agentId = input.agent_id ?? "default";
  const exactMatch = db.prepare("SELECT id FROM memories WHERE hash = ? AND agent_id = ?").get(hash, agentId);
  if (exactMatch) {
    return { action: "skip", reason: "Exact duplicate (hash match)", existingId: exactMatch.id };
  }
  if (input.uri) {
    const existingPath = getPathByUri(db, input.uri);
    if (existingPath) {
      return {
        action: "update",
        reason: `URI ${input.uri} already exists, updating`,
        existingId: existingPath.memory_id
      };
    }
  }
  const similar = db.prepare(
    `SELECT m.id, m.content, m.type, rank
       FROM memories_fts f
       JOIN memories m ON m.id = f.id
       WHERE memories_fts MATCH ? AND m.agent_id = ?
       ORDER BY rank
       LIMIT 3`
  ).all(escapeFts(input.content), agentId);
  if (similar.length > 0 && similar[0].rank < -10) {
    const existing = similar[0];
    if (existing.type === input.type) {
      const merged = `${existing.content}

[Updated] ${input.content}`;
      return {
        action: "merge",
        reason: "Similar content found, merging",
        existingId: existing.id,
        mergedContent: merged
      };
    }
  }
  const priority = input.priority ?? (input.type === "identity" ? 0 : input.type === "emotion" ? 1 : 2);
  if (priority <= 1) {
    if (!input.content.trim()) {
      return { action: "skip", reason: "Empty content rejected by gate" };
    }
  }
  return { action: "add", reason: "Passed all guard checks" };
}
function escapeFts(text) {
  const words = text.slice(0, 100).replace(/[^\w\u4e00-\u9fff\s]/g, " ").split(/\s+/).filter((w) => w.length > 1).slice(0, 5);
  if (words.length === 0) return '""';
  return words.map((w) => `"${w}"`).join(" OR ");
}
export {
  contentHash,
  countMemories,
  createLink,
  createMemory,
  createPath,
  createSnapshot,
  deleteLink,
  deleteMemory,
  deletePath,
  getLinks,
  getMemory,
  getOutgoingLinks,
  getPath,
  getPathByUri,
  getPathsByDomain,
  getPathsByMemory,
  getPathsByPrefix,
  getSnapshot,
  getSnapshots,
  guard,
  listMemories,
  openDatabase,
  parseUri,
  recordAccess,
  rollback,
  traverse,
  updateMemory
};
//# sourceMappingURL=index.js.map