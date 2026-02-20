// AgentMemory v2 — Sleep sync engine (light sleep phase)
// Captures new information, deduplicates, writes structured memories
import type Database from "better-sqlite3";
import { createMemory, type CreateMemoryInput, type Memory } from "../core/memory.js";
import { createPath, getPathByUri } from "../core/path.js";
import { createSnapshot } from "../core/snapshot.js";
import { guard } from "../core/guard.js";
import { updateMemory } from "../core/memory.js";

export interface SyncInput {
  content: string;
  type?: CreateMemoryInput["type"];
  priority?: CreateMemoryInput["priority"];
  emotion_val?: number;
  uri?: string;
  source?: string;
  agent_id?: string;
}

export interface SyncResult {
  action: "added" | "updated" | "merged" | "skipped";
  memoryId?: string;
  reason: string;
}

/**
 * Sync a single piece of information into memory.
 * Runs full Write Guard pipeline before writing.
 */
export function syncOne(db: Database.Database, input: SyncInput): SyncResult {
  const memInput: CreateMemoryInput & { uri?: string } = {
    content: input.content,
    type: input.type ?? "event",
    priority: input.priority,
    emotion_val: input.emotion_val,
    source: input.source,
    agent_id: input.agent_id,
    uri: input.uri,
  };

  // Run Write Guard
  const guardResult = guard(db, memInput);

  switch (guardResult.action) {
    case "skip":
      return { action: "skipped", reason: guardResult.reason, memoryId: guardResult.existingId };

    case "add": {
      const mem = createMemory(db, memInput);
      if (!mem) return { action: "skipped", reason: "createMemory returned null" };

      // Create URI path if provided
      if (input.uri) {
        try {
          createPath(db, mem.id, input.uri);
        } catch {
          // URI might already exist, that's OK
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

/**
 * Sync multiple items in a batch (within a transaction).
 */
export function syncBatch(db: Database.Database, inputs: SyncInput[]): SyncResult[] {
  const results: SyncResult[] = [];
  const transaction = db.transaction(() => {
    for (const input of inputs) {
      results.push(syncOne(db, input));
    }
  });
  transaction();
  return results;
}
