// AgentMemory v4 — Sleep tidy engine (deep sleep phase)
// Compression / merge / archive only. Governance belongs in govern.ts.
import type Database from "better-sqlite3";
import { deleteMemory } from "../core/memory.js";
import { getDecayedMemories } from "./decay.js";

export interface TidyResult {
  archived: number;
  orphansCleaned: number;
}

/**
 * Run the tidy (deep sleep) cycle:
 * 1. Archive decayed P3 memories (vitality < threshold)
 *
 * Path/orphan cleanup moved to govern.ts in Phase 2.
 */
export function runTidy(
  db: Database.Database,
  opts?: {
    vitalityThreshold?: number;
    agent_id?: string;
  },
): TidyResult {
  const threshold = opts?.vitalityThreshold ?? 0.05;
  const agentId = opts?.agent_id;

  let archived = 0;

  const transaction = db.transaction(() => {
    const decayed = getDecayedMemories(db, threshold, agentId ? { agent_id: agentId } : undefined);
    for (const mem of decayed) {
      deleteMemory(db, mem.id);
      archived += 1;
    }
  });

  transaction();

  return { archived, orphansCleaned: 0 };
}
