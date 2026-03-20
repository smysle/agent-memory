// AgentMemory — Memory CRUD operations
import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { newId, now } from "./db.js";
import { tokenizeForIndex } from "../search/tokenizer.js";
import { getConfiguredEmbeddingProviderId } from "../search/providers.js";
import { markAllEmbeddingsPending, markMemoryEmbeddingPending } from "../search/vector.js";

export type MemoryType = "identity" | "emotion" | "knowledge" | "event";
export type Priority = 0 | 1 | 2 | 3;

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  priority: Priority;
  emotion_val: number;
  vitality: number;
  stability: number;
  access_count: number;
  last_accessed: string | null;
  created_at: string;
  updated_at: string;
  source: string | null;
  agent_id: string;
  hash: string | null;
  emotion_tag: string | null;
  source_session: string | null;
  source_context: string | null;
  observed_at: string | null;
}

export interface CreateMemoryInput {
  content: string;
  type: MemoryType;
  priority?: Priority;
  emotion_val?: number;
  source?: string;
  agent_id?: string;
  embedding_provider_id?: string | null;
  emotion_tag?: string;
  source_session?: string;
  source_context?: string;
  observed_at?: string;
}

export interface UpdateMemoryInput {
  content?: string;
  type?: MemoryType;
  priority?: Priority;
  emotion_val?: number;
  vitality?: number;
  stability?: number;
  source?: string;
  embedding_provider_id?: string | null;
  emotion_tag?: string | null;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex").slice(0, 16);
}

// Priority defaults based on type
const TYPE_PRIORITY: Record<MemoryType, Priority> = {
  identity: 0,
  emotion: 1,
  knowledge: 2,
  event: 3,
};

// Initial stability (Ebbinghaus S parameter) based on priority
const PRIORITY_STABILITY: Record<Priority, number> = {
  0: Infinity, // P0: never decays
  1: 365, // P1: 365-day half-life
  2: 90, // P2: 90-day half-life
  3: 14, // P3: 14-day half-life
};

function resolveEmbeddingProviderId(explicitProviderId?: string | null): string | null {
  if (explicitProviderId !== undefined) {
    return explicitProviderId;
  }
  return getConfiguredEmbeddingProviderId();
}

function markEmbeddingDirtyIfNeeded(
  db: Database.Database,
  memoryId: string,
  hash: string,
  providerId?: string | null,
): void {
  if (!providerId) return;
  try {
    markMemoryEmbeddingPending(db, memoryId, providerId, hash);
  } catch {
    // Older schemas (for migration tests) may not have the embeddings table yet.
  }
}

export function createMemory(db: Database.Database, input: CreateMemoryInput): Memory | null {
  const hash = contentHash(input.content);
  const agentId = input.agent_id ?? "default";
  const priority = input.priority ?? TYPE_PRIORITY[input.type];
  const stability = PRIORITY_STABILITY[priority];

  // Dedup: check if identical content already exists for this agent
  const existing = db
    .prepare("SELECT id FROM memories WHERE hash = ? AND agent_id = ?")
    .get(hash, agentId) as { id: string } | undefined;
  if (existing) {
    return null; // Already exists, skip
  }

  const id = newId();
  const timestamp = now();
  const sourceContext = input.source_context ? input.source_context.slice(0, 200) : null;

  db.prepare(
    `INSERT INTO memories (id, content, type, priority, emotion_val, vitality, stability,
     access_count, created_at, updated_at, source, agent_id, hash, emotion_tag,
     source_session, source_context, observed_at)
     VALUES (?, ?, ?, ?, ?, 1.0, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.content,
    input.type,
    priority,
    input.emotion_val ?? 0.0,
    stability === Infinity ? 999999 : stability,
    timestamp,
    timestamp,
    input.source ?? null,
    agentId,
    hash,
    input.emotion_tag ?? null,
    input.source_session ?? null,
    sourceContext,
    input.observed_at ?? null,
  );

  // Sync to FTS index (tokenized for CJK support)
  db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run(id, tokenizeForIndex(input.content));

  markEmbeddingDirtyIfNeeded(db, id, hash, resolveEmbeddingProviderId(input.embedding_provider_id));

  return getMemory(db, id)!;
}

export function getMemory(db: Database.Database, id: string): Memory | null {
  return (db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory) ?? null;
}

export function updateMemory(
  db: Database.Database,
  id: string,
  input: UpdateMemoryInput,
): Memory | null {
  const existing = getMemory(db, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: unknown[] = [];
  let nextHash: string | null = null;

  if (input.content !== undefined) {
    nextHash = contentHash(input.content);
    fields.push("content = ?", "hash = ?");
    values.push(input.content, nextHash);
  }
  if (input.type !== undefined) {
    fields.push("type = ?");
    values.push(input.type);
  }
  if (input.priority !== undefined) {
    fields.push("priority = ?");
    values.push(input.priority);
  }
  if (input.emotion_val !== undefined) {
    fields.push("emotion_val = ?");
    values.push(input.emotion_val);
  }
  if (input.vitality !== undefined) {
    fields.push("vitality = ?");
    values.push(input.vitality);
  }
  if (input.stability !== undefined) {
    fields.push("stability = ?");
    values.push(input.stability);
  }
  if (input.source !== undefined) {
    fields.push("source = ?");
    values.push(input.source);
  }
  if (input.emotion_tag !== undefined) {
    fields.push("emotion_tag = ?");
    values.push(input.emotion_tag);
  }

  fields.push("updated_at = ?");
  values.push(now());
  values.push(id);

  db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  // Update FTS if content changed
  if (input.content !== undefined) {
    db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
    db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run(id, tokenizeForIndex(input.content));

    if (nextHash) {
      try {
        markAllEmbeddingsPending(db, id, nextHash);
      } catch {
        // Older schemas (for migration tests) may not have the embeddings table yet.
      }
      markEmbeddingDirtyIfNeeded(db, id, nextHash, resolveEmbeddingProviderId(input.embedding_provider_id));
    }
  }

  return getMemory(db, id);
}

export function deleteMemory(db: Database.Database, id: string): boolean {
  // FTS cleanup
  db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
  // Embedding cleanup (best-effort for older schemas)
  try { db.prepare("DELETE FROM embeddings WHERE memory_id = ?").run(id); } catch {}
  const result = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return result.changes > 0;
}

export interface ArchivedMemory {
  id: string;
  content: string;
  type: string;
  priority: number;
  emotion_val: number;
  vitality: number;
  stability: number;
  access_count: number;
  last_accessed: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string;
  archive_reason: string;
  source: string | null;
  agent_id: string;
  hash: string | null;
  emotion_tag: string | null;
  source_session: string | null;
  source_context: string | null;
  observed_at: string | null;
}

/**
 * Archive a memory to memory_archive, then delete from memories.
 * If minVitality is set (default 0.1), memories below that threshold
 * are directly deleted without archiving — they're decayed noise.
 * Returns "archived" if actually archived, "deleted" if skipped to direct delete,
 * or false if memory not found.
 */
export function archiveMemory(
  db: Database.Database,
  id: string,
  reason?: string,
  opts?: { minVitality?: number },
): "archived" | "deleted" | false {
  const mem = getMemory(db, id);
  if (!mem) return false;

  const minVitality = opts?.minVitality ?? 0.1;

  // Below minVitality → direct delete, not worth archiving
  if (mem.vitality < minVitality) {
    deleteMemory(db, id);
    return "deleted";
  }

  const archivedAt = now();
  const archiveReason = reason ?? "eviction";

  db.prepare(
    `INSERT OR REPLACE INTO memory_archive
     (id, content, type, priority, emotion_val, vitality, stability, access_count,
      last_accessed, created_at, updated_at, archived_at, archive_reason,
      source, agent_id, hash, emotion_tag, source_session, source_context, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mem.id, mem.content, mem.type, mem.priority, mem.emotion_val,
    mem.vitality, mem.stability, mem.access_count, mem.last_accessed,
    mem.created_at, mem.updated_at, archivedAt, archiveReason,
    mem.source, mem.agent_id, mem.hash, mem.emotion_tag,
    mem.source_session, mem.source_context, mem.observed_at,
  );

  deleteMemory(db, id);
  return "archived";
}

export function restoreMemory(db: Database.Database, id: string): Memory | null {
  const archived = db.prepare("SELECT * FROM memory_archive WHERE id = ?").get(id) as ArchivedMemory | undefined;
  if (!archived) return null;

  // Re-insert into memories table
  db.prepare(
    `INSERT INTO memories
     (id, content, type, priority, emotion_val, vitality, stability, access_count,
      last_accessed, created_at, updated_at, source, agent_id, hash, emotion_tag,
      source_session, source_context, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    archived.id, archived.content, archived.type, archived.priority,
    archived.emotion_val, archived.vitality, archived.stability,
    archived.access_count, archived.last_accessed, archived.created_at,
    now(), // updated_at = restore time
    archived.source, archived.agent_id, archived.hash, archived.emotion_tag,
    archived.source_session, archived.source_context, archived.observed_at,
  );

  // Rebuild FTS index
  db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run(
    archived.id,
    tokenizeForIndex(archived.content),
  );

  // Mark embedding as pending
  if (archived.hash) {
    const providerId = getConfiguredEmbeddingProviderId();
    if (providerId) {
      try {
        markMemoryEmbeddingPending(db, archived.id, providerId, archived.hash);
      } catch {
        // Older schemas may not have the embeddings table.
      }
    }
  }

  // Remove from archive
  db.prepare("DELETE FROM memory_archive WHERE id = ?").run(id);

  return getMemory(db, archived.id)!;
}

export function listArchivedMemories(
  db: Database.Database,
  opts?: { agent_id?: string; limit?: number },
): ArchivedMemory[] {
  const agentId = opts?.agent_id;
  const limit = opts?.limit ?? 20;

  if (agentId) {
    return db.prepare(
      "SELECT * FROM memory_archive WHERE agent_id = ? ORDER BY archived_at DESC LIMIT ?",
    ).all(agentId, limit) as ArchivedMemory[];
  }
  return db.prepare(
    "SELECT * FROM memory_archive ORDER BY archived_at DESC LIMIT ?",
  ).all(limit) as ArchivedMemory[];
}

export function purgeArchive(db: Database.Database, opts?: { agent_id?: string }): number {
  if (opts?.agent_id) {
    return db.prepare("DELETE FROM memory_archive WHERE agent_id = ?").run(opts.agent_id).changes;
  }
  return db.prepare("DELETE FROM memory_archive").run().changes;
}

export function listMemories(
  db: Database.Database,
  opts?: {
    agent_id?: string;
    type?: MemoryType;
    priority?: Priority;
    min_vitality?: number;
    limit?: number;
    offset?: number;
    emotion_tag?: string;
  },
): Memory[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.agent_id) {
    conditions.push("agent_id = ?");
    params.push(opts.agent_id);
  }
  if (opts?.type) {
    conditions.push("type = ?");
    params.push(opts.type);
  }
  if (opts?.priority !== undefined) {
    conditions.push("priority = ?");
    params.push(opts.priority);
  }
  if (opts?.min_vitality !== undefined) {
    conditions.push("vitality >= ?");
    params.push(opts.min_vitality);
  }
  if (opts?.emotion_tag) {
    conditions.push("emotion_tag = ?");
    params.push(opts.emotion_tag);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;

  return db
    .prepare(`SELECT * FROM memories ${where} ORDER BY priority ASC, updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Memory[];
}

export function recordAccess(db: Database.Database, id: string, growthFactor = 1.5): void {
  const mem = getMemory(db, id);
  if (!mem) return;

  const newStability = Math.min(999999, mem.stability * growthFactor);

  db.prepare(
    `UPDATE memories SET access_count = access_count + 1, last_accessed = ?, stability = ?,
     vitality = MIN(1.0, vitality * 1.2) WHERE id = ?`,
  ).run(now(), newStability, id);
}

export function countMemories(
  db: Database.Database,
  agent_id = "default",
): { total: number; by_type: Record<string, number>; by_priority: Record<string, number> } {
  const total = (
    db.prepare("SELECT COUNT(*) as c FROM memories WHERE agent_id = ?").get(agent_id) as {
      c: number;
    }
  ).c;

  const byType = db
    .prepare("SELECT type, COUNT(*) as c FROM memories WHERE agent_id = ? GROUP BY type")
    .all(agent_id) as Array<{ type: string; c: number }>;

  const byPriority = db
    .prepare("SELECT priority, COUNT(*) as c FROM memories WHERE agent_id = ? GROUP BY priority")
    .all(agent_id) as Array<{ priority: number; c: number }>;

  return {
    total,
    by_type: Object.fromEntries(byType.map((r) => [r.type, r.c])),
    by_priority: Object.fromEntries(byPriority.map((r) => [`P${r.priority}`, r.c])),
  };
}
