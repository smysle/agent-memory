#!/usr/bin/env node
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

// src/search/bm25.ts
function searchBM25(db, query, opts) {
  const limit = opts?.limit ?? 20;
  const agentId = opts?.agent_id ?? "default";
  const minVitality = opts?.min_vitality ?? 0;
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];
  try {
    const rows = db.prepare(
      `SELECT m.*, rank AS score
         FROM memories_fts f
         JOIN memories m ON m.id = f.id
         WHERE memories_fts MATCH ?
           AND m.agent_id = ?
           AND m.vitality >= ?
         ORDER BY rank
         LIMIT ?`
    ).all(ftsQuery, agentId, minVitality, limit);
    return rows.map((row) => ({
      memory: { ...row, score: void 0 },
      score: Math.abs(row.score),
      // FTS5 rank is negative (lower = better)
      matchReason: "bm25"
    }));
  } catch {
    return searchSimple(db, query, agentId, minVitality, limit);
  }
}
function searchSimple(db, query, agentId, minVitality, limit) {
  const rows = db.prepare(
    `SELECT * FROM memories
       WHERE agent_id = ? AND vitality >= ? AND content LIKE ?
       ORDER BY priority ASC, updated_at DESC
       LIMIT ?`
  ).all(agentId, minVitality, `%${query}%`, limit);
  return rows.map((m, i) => ({
    memory: m,
    score: 1 / (i + 1),
    // Simple rank by position
    matchReason: "like"
  }));
}
function buildFtsQuery(text) {
  const words = text.replace(/[^\w\u4e00-\u9fff\u3040-\u30ff\s]/g, " ").split(/\s+/).filter((w) => w.length > 1).slice(0, 10);
  if (words.length === 0) return null;
  return words.map((w) => `"${w}"`).join(" OR ");
}

// src/search/intent.ts
var INTENT_PATTERNS = {
  factual: [
    /^(what|who|where|which|how much|how many)/i,
    /是(什么|谁|哪)/,
    /叫什么/,
    /名字/,
    /地址/,
    /号码/,
    /密码/,
    /配置/,
    /设置/
  ],
  temporal: [
    /^(when|what time|how long)/i,
    /(yesterday|today|last week|recently|ago|before|after)/i,
    /什么时候/,
    /(昨天|今天|上周|最近|以前|之前|之后)/,
    /\d{4}[-/]\d{1,2}/,
    /(几月|几号|几点)/
  ],
  causal: [
    /^(why|how come|what caused)/i,
    /^(because|due to|reason)/i,
    /为什么/,
    /原因/,
    /导致/,
    /怎么回事/,
    /为啥/
  ],
  exploratory: [
    /^(how|tell me about|explain|describe)/i,
    /^(what do you think|what about)/i,
    /怎么样/,
    /介绍/,
    /说说/,
    /讲讲/,
    /有哪些/,
    /关于/
  ]
};
function classifyIntent(query) {
  const scores = {
    factual: 0,
    exploratory: 0,
    temporal: 0,
    causal: 0
  };
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(query)) {
        scores[intent] += 1;
      }
    }
  }
  let maxIntent = "factual";
  let maxScore = 0;
  for (const [intent, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxIntent = intent;
    }
  }
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = totalScore > 0 ? maxScore / totalScore : 0.5;
  return { intent: maxIntent, confidence };
}
function getStrategy(intent) {
  switch (intent) {
    case "factual":
      return { boostRecent: false, boostPriority: true, limit: 5 };
    case "temporal":
      return { boostRecent: true, boostPriority: false, limit: 10 };
    case "causal":
      return { boostRecent: false, boostPriority: false, limit: 10 };
    case "exploratory":
      return { boostRecent: false, boostPriority: false, limit: 15 };
  }
}

// src/search/rerank.ts
function rerank(results, opts) {
  const now2 = Date.now();
  const scored = results.map((r) => {
    let finalScore = r.score;
    if (opts.boostPriority) {
      const priorityMultiplier = [4, 3, 2, 1][r.memory.priority] ?? 1;
      finalScore *= priorityMultiplier;
    }
    if (opts.boostRecent && r.memory.updated_at) {
      const age = now2 - new Date(r.memory.updated_at).getTime();
      const daysSinceUpdate = age / (1e3 * 60 * 60 * 24);
      const recencyBoost = Math.max(0.1, 1 / (1 + daysSinceUpdate * 0.1));
      finalScore *= recencyBoost;
    }
    finalScore *= Math.max(0.1, r.memory.vitality);
    return { ...r, score: finalScore };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit);
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

// src/sleep/boot.ts
function boot(db, opts) {
  const agentId = opts?.agent_id ?? "default";
  const corePaths = opts?.corePaths ?? [
    "core://agent",
    "core://user",
    "core://agent/identity",
    "core://user/identity"
  ];
  const memories = /* @__PURE__ */ new Map();
  const identities = listMemories(db, { agent_id: agentId, priority: 0 });
  for (const mem of identities) {
    memories.set(mem.id, mem);
    recordAccess(db, mem.id, 1.1);
  }
  const bootPaths = [];
  for (const uri of corePaths) {
    const path = getPathByUri(db, uri);
    if (path) {
      bootPaths.push(uri);
      if (!memories.has(path.memory_id)) {
        const mem = getMemory(db, path.memory_id);
        if (mem) {
          memories.set(mem.id, mem);
          recordAccess(db, mem.id, 1.1);
        }
      }
    }
  }
  const bootEntry = getPathByUri(db, "system://boot");
  if (bootEntry) {
    const bootMem = getMemory(db, bootEntry.memory_id);
    if (bootMem) {
      const additionalUris = bootMem.content.split("\n").map((l) => l.trim()).filter((l) => l.match(/^[a-z]+:\/\//));
      for (const uri of additionalUris) {
        const path = getPathByUri(db, uri);
        if (path && !memories.has(path.memory_id)) {
          const mem = getMemory(db, path.memory_id);
          if (mem) {
            memories.set(mem.id, mem);
            bootPaths.push(uri);
          }
        }
      }
    }
  }
  return {
    identityMemories: [...memories.values()],
    bootPaths
  };
}

// src/sleep/decay.ts
var MIN_VITALITY = {
  0: 1,
  // P0: identity — never decays
  1: 0.3,
  // P1: emotion — slow decay
  2: 0.1,
  // P2: knowledge — normal decay
  3: 0
  // P3: event — full decay
};
function calculateVitality(stability, daysSinceCreation, priority) {
  if (priority === 0) return 1;
  const S = Math.max(0.01, stability);
  const retention = Math.exp(-daysSinceCreation / S);
  const minVit = MIN_VITALITY[priority] ?? 0;
  return Math.max(minVit, retention);
}
function runDecay(db) {
  const currentTime = now();
  const currentMs = new Date(currentTime).getTime();
  const memories = db.prepare("SELECT id, priority, stability, created_at, vitality FROM memories WHERE priority > 0").all();
  let updated = 0;
  let decayed = 0;
  let belowThreshold = 0;
  const updateStmt = db.prepare("UPDATE memories SET vitality = ?, updated_at = ? WHERE id = ?");
  const transaction = db.transaction(() => {
    for (const mem of memories) {
      const createdMs = new Date(mem.created_at).getTime();
      const daysSince = (currentMs - createdMs) / (1e3 * 60 * 60 * 24);
      const newVitality = calculateVitality(mem.stability, daysSince, mem.priority);
      if (Math.abs(newVitality - mem.vitality) > 1e-3) {
        updateStmt.run(newVitality, currentTime, mem.id);
        updated++;
        if (newVitality < mem.vitality) {
          decayed++;
        }
        if (newVitality < 0.05) {
          belowThreshold++;
        }
      }
    }
  });
  transaction();
  return { updated, decayed, belowThreshold };
}
function getDecayedMemories(db, threshold = 0.05) {
  return db.prepare(
    `SELECT id, content, vitality, priority FROM memories
       WHERE vitality < ? AND priority >= 3
       ORDER BY vitality ASC`
  ).all(threshold);
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

// src/sleep/tidy.ts
function runTidy(db, opts) {
  const threshold = opts?.vitalityThreshold ?? 0.05;
  const maxSnapshots = opts?.maxSnapshotsPerMemory ?? 10;
  let archived = 0;
  let orphansCleaned = 0;
  let snapshotsPruned = 0;
  const transaction = db.transaction(() => {
    const decayed = getDecayedMemories(db, threshold);
    for (const mem of decayed) {
      try {
        createSnapshot(db, mem.id, "delete", "tidy");
      } catch {
      }
      deleteMemory(db, mem.id);
      archived++;
    }
    const orphans = db.prepare(
      `DELETE FROM paths WHERE memory_id NOT IN (SELECT id FROM memories)`
    ).run();
    orphansCleaned = orphans.changes;
    const memoriesWithSnapshots = db.prepare(
      `SELECT memory_id, COUNT(*) as cnt FROM snapshots
         GROUP BY memory_id HAVING cnt > ?`
    ).all(maxSnapshots);
    for (const { memory_id } of memoriesWithSnapshots) {
      const pruned = db.prepare(
        `DELETE FROM snapshots WHERE id NOT IN (
            SELECT id FROM snapshots WHERE memory_id = ?
            ORDER BY created_at DESC LIMIT ?
          ) AND memory_id = ?`
      ).run(memory_id, maxSnapshots, memory_id);
      snapshotsPruned += pruned.changes;
    }
  });
  transaction();
  return { archived, orphansCleaned, snapshotsPruned };
}

// src/sleep/govern.ts
function runGovern(db) {
  let orphanPaths = 0;
  let orphanLinks = 0;
  let emptyMemories = 0;
  const transaction = db.transaction(() => {
    const pathResult = db.prepare("DELETE FROM paths WHERE memory_id NOT IN (SELECT id FROM memories)").run();
    orphanPaths = pathResult.changes;
    const linkResult = db.prepare(
      `DELETE FROM links WHERE
         source_id NOT IN (SELECT id FROM memories) OR
         target_id NOT IN (SELECT id FROM memories)`
    ).run();
    orphanLinks = linkResult.changes;
    const emptyResult = db.prepare("DELETE FROM memories WHERE TRIM(content) = ''").run();
    emptyMemories = emptyResult.changes;
  });
  transaction();
  return { orphanPaths, orphanLinks, emptyMemories };
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

// src/sleep/sync.ts
function syncOne(db, input) {
  const memInput = {
    content: input.content,
    type: input.type ?? "event",
    priority: input.priority,
    emotion_val: input.emotion_val,
    source: input.source,
    agent_id: input.agent_id,
    uri: input.uri
  };
  const guardResult = guard(db, memInput);
  switch (guardResult.action) {
    case "skip":
      return { action: "skipped", reason: guardResult.reason, memoryId: guardResult.existingId };
    case "add": {
      const mem = createMemory(db, memInput);
      if (!mem) return { action: "skipped", reason: "createMemory returned null" };
      if (input.uri) {
        try {
          createPath(db, mem.id, input.uri);
        } catch {
        }
      }
      return { action: "added", memoryId: mem.id, reason: guardResult.reason };
    }
    case "update": {
      if (!guardResult.existingId) return { action: "skipped", reason: "No existing ID for update" };
      createSnapshot(db, guardResult.existingId, "update", "sync");
      updateMemory(db, guardResult.existingId, { content: input.content });
      return { action: "updated", memoryId: guardResult.existingId, reason: guardResult.reason };
    }
    case "merge": {
      if (!guardResult.existingId || !guardResult.mergedContent) {
        return { action: "skipped", reason: "Missing merge data" };
      }
      createSnapshot(db, guardResult.existingId, "merge", "sync");
      updateMemory(db, guardResult.existingId, { content: guardResult.mergedContent });
      return { action: "merged", memoryId: guardResult.existingId, reason: guardResult.reason };
    }
  }
}

// src/bin/agent-memory.ts
import { existsSync, readFileSync, readdirSync } from "fs";
import { resolve, basename } from "path";
var args = process.argv.slice(2);
var command = args[0];
function getDbPath() {
  return process.env.AGENT_MEMORY_DB ?? "./agent-memory.db";
}
function printHelp() {
  console.log(`
\u{1F9E0} AgentMemory v2 \u2014 Sleep-cycle memory for AI agents

Usage: agent-memory <command> [options]

Commands:
  init                          Create database
  remember <content> [--uri X] [--type T]  Store a memory
  recall <query> [--limit N]    Search memories
  boot                          Load identity memories
  status                        Show statistics
  reflect [decay|tidy|govern|all]  Run sleep cycle
  migrate <dir>                 Import from Markdown files
  help                          Show this help

Environment:
  AGENT_MEMORY_DB      Database path (default: ./agent-memory.db)
  AGENT_MEMORY_AGENT_ID  Agent ID (default: "default")
`);
}
function getFlag(flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return void 0;
}
try {
  switch (command) {
    case "init": {
      const dbPath = getDbPath();
      openDatabase({ path: dbPath });
      console.log(`\u2705 Database created at ${dbPath}`);
      break;
    }
    case "remember": {
      const content = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      if (!content) {
        console.error("Usage: agent-memory remember <content>");
        process.exit(1);
      }
      const db = openDatabase({ path: getDbPath() });
      const uri = getFlag("--uri");
      const type = getFlag("--type") ?? "knowledge";
      const result = syncOne(db, { content, type, uri });
      console.log(`${result.action}: ${result.reason}${result.memoryId ? ` (${result.memoryId.slice(0, 8)})` : ""}`);
      db.close();
      break;
    }
    case "recall": {
      const query = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      if (!query) {
        console.error("Usage: agent-memory recall <query>");
        process.exit(1);
      }
      const db = openDatabase({ path: getDbPath() });
      const limit = parseInt(getFlag("--limit") ?? "10");
      const { intent } = classifyIntent(query);
      const strategy = getStrategy(intent);
      const raw = searchBM25(db, query, { limit: limit * 2 });
      const results = rerank(raw, { ...strategy, limit });
      console.log(`\u{1F50D} Intent: ${intent} | Results: ${results.length}
`);
      for (const r of results) {
        const p = ["\u{1F534}", "\u{1F7E0}", "\u{1F7E1}", "\u26AA"][r.memory.priority];
        const v = (r.memory.vitality * 100).toFixed(0);
        console.log(`${p} P${r.memory.priority} [${v}%] ${r.memory.content.slice(0, 80)}`);
      }
      db.close();
      break;
    }
    case "boot": {
      const db = openDatabase({ path: getDbPath() });
      const result = boot(db);
      console.log(`\u{1F9E0} Boot: ${result.identityMemories.length} identity memories loaded
`);
      for (const m of result.identityMemories) {
        console.log(`  \u{1F534} ${m.content.slice(0, 100)}`);
      }
      if (result.bootPaths.length) {
        console.log(`
\u{1F4CD} Boot paths: ${result.bootPaths.join(", ")}`);
      }
      db.close();
      break;
    }
    case "status": {
      const db = openDatabase({ path: getDbPath() });
      const stats = countMemories(db);
      const lowVit = db.prepare("SELECT COUNT(*) as c FROM memories WHERE vitality < 0.1").get().c;
      const paths = db.prepare("SELECT COUNT(*) as c FROM paths").get().c;
      const links = db.prepare("SELECT COUNT(*) as c FROM links").get().c;
      const snaps = db.prepare("SELECT COUNT(*) as c FROM snapshots").get().c;
      console.log("\u{1F9E0} AgentMemory Status\n");
      console.log(`  Total memories: ${stats.total}`);
      console.log(`  By type: ${Object.entries(stats.by_type).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      console.log(`  By priority: ${Object.entries(stats.by_priority).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      console.log(`  Paths: ${paths} | Links: ${links} | Snapshots: ${snaps}`);
      console.log(`  Low vitality (<10%): ${lowVit}`);
      db.close();
      break;
    }
    case "reflect": {
      const phase = args[1] ?? "all";
      const db = openDatabase({ path: getDbPath() });
      console.log(`\u{1F319} Running ${phase} phase...
`);
      if (phase === "decay" || phase === "all") {
        const r = runDecay(db);
        console.log(`  Decay: ${r.updated} updated, ${r.decayed} decayed, ${r.belowThreshold} below threshold`);
      }
      if (phase === "tidy" || phase === "all") {
        const r = runTidy(db);
        console.log(`  Tidy: ${r.archived} archived, ${r.orphansCleaned} orphans, ${r.snapshotsPruned} snapshots pruned`);
      }
      if (phase === "govern" || phase === "all") {
        const r = runGovern(db);
        console.log(`  Govern: ${r.orphanPaths} paths, ${r.orphanLinks} links, ${r.emptyMemories} empty cleaned`);
      }
      db.close();
      break;
    }
    case "migrate": {
      const dir = args[1];
      if (!dir) {
        console.error("Usage: agent-memory migrate <directory>");
        process.exit(1);
      }
      const dirPath = resolve(dir);
      if (!existsSync(dirPath)) {
        console.error(`Directory not found: ${dirPath}`);
        process.exit(1);
      }
      const db = openDatabase({ path: getDbPath() });
      let imported = 0;
      const memoryMd = resolve(dirPath, "MEMORY.md");
      if (existsSync(memoryMd)) {
        const content = readFileSync(memoryMd, "utf-8");
        const sections = content.split(/^## /m).filter((s) => s.trim());
        for (const section of sections) {
          const lines = section.split("\n");
          const title = lines[0]?.trim();
          const body = lines.slice(1).join("\n").trim();
          if (!body) continue;
          const type = title?.toLowerCase().includes("\u5173\u4E8E") || title?.toLowerCase().includes("about") ? "identity" : "knowledge";
          const uri = `knowledge://memory-md/${title?.replace(/[^a-z0-9\u4e00-\u9fff]/gi, "-").toLowerCase()}`;
          syncOne(db, { content: `## ${title}
${body}`, type, uri, source: "migrate:MEMORY.md" });
          imported++;
        }
        console.log(`\u{1F4C4} MEMORY.md: ${sections.length} sections imported`);
      }
      const mdFiles = readdirSync(dirPath).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
      for (const file of mdFiles) {
        const content = readFileSync(resolve(dirPath, file), "utf-8");
        const date = basename(file, ".md");
        syncOne(db, {
          content,
          type: "event",
          uri: `event://journal/${date}`,
          source: `migrate:${file}`
        });
        imported++;
      }
      if (mdFiles.length) console.log(`\u{1F4DD} Journals: ${mdFiles.length} files imported`);
      const weeklyDir = resolve(dirPath, "weekly");
      if (existsSync(weeklyDir)) {
        const weeklyFiles = readdirSync(weeklyDir).filter((f) => f.endsWith(".md"));
        for (const file of weeklyFiles) {
          const content = readFileSync(resolve(weeklyDir, file), "utf-8");
          const week = basename(file, ".md");
          syncOne(db, {
            content,
            type: "knowledge",
            uri: `knowledge://weekly/${week}`,
            source: `migrate:weekly/${file}`
          });
          imported++;
        }
        if (weeklyFiles.length) console.log(`\u{1F4E6} Weekly: ${weeklyFiles.length} files imported`);
      }
      console.log(`
\u2705 Migration complete: ${imported} items imported`);
      db.close();
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case void 0:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
//# sourceMappingURL=agent-memory.js.map