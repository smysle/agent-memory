// AgentMemory v3 — Sleep sync engine (light sleep phase)
// Captures new information, deduplicates, writes structured memories
import type Database from "better-sqlite3";
import { createMemory, type CreateMemoryInput, updateMemory } from "../core/memory.js";
import { createPath, getPathByUri } from "../core/path.js";
import { guard, type ConflictInfo } from "../core/guard.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { now as dbNow, newId } from "../core/db.js";

export interface SyncInput {
  content: string;
  type?: CreateMemoryInput["type"];
  priority?: CreateMemoryInput["priority"];
  emotion_val?: number;
  uri?: string;
  source?: string;
  agent_id?: string;
  provider?: EmbeddingProvider | null;
  conservative?: boolean;
  emotion_tag?: string;
  source_session?: string;
  source_context?: string;
  observed_at?: string;
}

export interface SyncResult {
  action: "added" | "updated" | "merged" | "skipped";
  memoryId?: string;
  reason: string;
  conflicts?: ConflictInfo[];
}

function ensureUriPath(db: Database.Database, memoryId: string, uri?: string, agentId?: string): void {
  if (!uri) return;
  if (getPathByUri(db, uri, agentId ?? "default")) return;
  try {
    createPath(db, memoryId, uri, undefined, undefined, agentId);
  } catch {
    // URI might already exist or belong to a conflicting path; guard already decided best effort.
  }
}

/**
 * Create automatic links for a memory based on guard candidates.
 * Links candidates with dedup_score ∈ [0.45, 0.82), max 5 per memory.
 */
function createAutoLinks(
  db: Database.Database,
  memoryId: string,
  candidates: Array<{ memoryId: string; dedup_score: number }> | undefined,
  agentId: string,
): void {
  if (!candidates || candidates.length === 0) return;

  const linkCandidates = candidates
    .filter((c) => c.memoryId !== memoryId && c.dedup_score >= 0.45 && c.dedup_score < 0.82)
    .sort((a, b) => b.dedup_score - a.dedup_score)
    .slice(0, 5);

  if (linkCandidates.length === 0) return;

  const timestamp = dbNow();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO links (agent_id, source_id, target_id, relation, weight, created_at)
     VALUES (?, ?, ?, 'related', ?, ?)`,
  );

  for (const candidate of linkCandidates) {
    insert.run(agentId, memoryId, candidate.memoryId, candidate.dedup_score, timestamp);
    // Also insert reverse link for bidirectional lookup
    insert.run(agentId, candidate.memoryId, memoryId, candidate.dedup_score, timestamp);
  }
}

/**
 * Sync a single piece of information into memory.
 * Runs full Write Guard pipeline before writing.
 */
export async function syncOne(db: Database.Database, input: SyncInput): Promise<SyncResult> {
  const memInput: CreateMemoryInput & {
    uri?: string;
    provider?: EmbeddingProvider | null;
    conservative?: boolean;
  } = {
    content: input.content,
    type: input.type ?? "event",
    priority: input.priority,
    emotion_val: input.emotion_val,
    source: input.source,
    agent_id: input.agent_id,
    uri: input.uri,
    provider: input.provider,
    conservative: input.conservative,
    emotion_tag: input.emotion_tag,
    source_session: input.source_session,
    source_context: input.source_context,
    observed_at: input.observed_at,
  };

  const guardResult = await guard(db, memInput);
  const agentId = input.agent_id ?? "default";

  switch (guardResult.action) {
    case "skip":
      return { action: "skipped", reason: guardResult.reason, memoryId: guardResult.existingId, conflicts: guardResult.conflicts };

    case "add": {
      const mem = createMemory(db, memInput);
      if (!mem) return { action: "skipped", reason: "createMemory returned null" };
      ensureUriPath(db, mem.id, input.uri, input.agent_id);
      createAutoLinks(db, mem.id, guardResult.candidates, agentId);
      return { action: "added", memoryId: mem.id, reason: guardResult.reason, conflicts: guardResult.conflicts };
    }

    case "update": {
      if (!guardResult.existingId) return { action: "skipped", reason: "No existing ID for update" };
      if (guardResult.updatedContent !== undefined) {
        updateMemory(db, guardResult.existingId, { content: guardResult.updatedContent });
      }
      ensureUriPath(db, guardResult.existingId, input.uri, input.agent_id);
      return { action: "updated", memoryId: guardResult.existingId, reason: guardResult.reason, conflicts: guardResult.conflicts };
    }

    case "merge": {
      if (!guardResult.existingId || !guardResult.mergedContent) {
        return { action: "skipped", reason: "Missing merge data" };
      }
      updateMemory(db, guardResult.existingId, { content: guardResult.mergedContent });
      ensureUriPath(db, guardResult.existingId, input.uri, input.agent_id);
      createAutoLinks(db, guardResult.existingId, guardResult.candidates, agentId);
      return { action: "merged", memoryId: guardResult.existingId, reason: guardResult.reason, conflicts: guardResult.conflicts };
    }
  }
}

/**
 * Sync multiple items in a batch.
 * Semantic guard may require async provider calls, so batch writes are serialized.
 */
export async function syncBatch(db: Database.Database, inputs: SyncInput[]): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const input of inputs) {
    results.push(await syncOne(db, input));
  }
  return results;
}
