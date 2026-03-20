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
  const result = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return result.changes > 0;
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
