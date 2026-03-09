// AgentMemory v3 — Sleep sync engine (light sleep phase)
// Captures new information, deduplicates, writes structured memories
import type Database from "better-sqlite3";
import { createMemory, type CreateMemoryInput, updateMemory } from "../core/memory.js";
import { createPath, getPathByUri } from "../core/path.js";
import { guard } from "../core/guard.js";
import type { EmbeddingProvider } from "../search/embedding.js";

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
}

export interface SyncResult {
  action: "added" | "updated" | "merged" | "skipped";
  memoryId?: string;
  reason: string;
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
  };

  const guardResult = await guard(db, memInput);

  switch (guardResult.action) {
    case "skip":
      return { action: "skipped", reason: guardResult.reason, memoryId: guardResult.existingId };

    case "add": {
      const mem = createMemory(db, memInput);
      if (!mem) return { action: "skipped", reason: "createMemory returned null" };
      ensureUriPath(db, mem.id, input.uri, input.agent_id);
      return { action: "added", memoryId: mem.id, reason: guardResult.reason };
    }

    case "update": {
      if (!guardResult.existingId) return { action: "skipped", reason: "No existing ID for update" };
      if (guardResult.updatedContent !== undefined) {
        updateMemory(db, guardResult.existingId, { content: guardResult.updatedContent });
      }
      ensureUriPath(db, guardResult.existingId, input.uri, input.agent_id);
      return { action: "updated", memoryId: guardResult.existingId, reason: guardResult.reason };
    }

    case "merge": {
      if (!guardResult.existingId || !guardResult.mergedContent) {
        return { action: "skipped", reason: "Missing merge data" };
      }
      updateMemory(db, guardResult.existingId, { content: guardResult.mergedContent });
      ensureUriPath(db, guardResult.existingId, input.uri, input.agent_id);
      return { action: "merged", memoryId: guardResult.existingId, reason: guardResult.reason };
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
