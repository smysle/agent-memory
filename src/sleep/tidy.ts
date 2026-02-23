// AgentMemory v3 — Sleep tidy engine (deep sleep phase)
// Compresses, distills, archives old memories
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
 * 2. Clean orphan paths (paths with no memory)
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
  let orphansCleaned = 0;

  const transaction = db.transaction(() => {
    // 1. Archive decayed memories
    const decayed = getDecayedMemories(db, threshold, agentId ? { agent_id: agentId } : undefined);
    for (const mem of decayed) {
      deleteMemory(db, mem.id);
      archived++;
    }

    // 2. Clean orphan paths (paths pointing to deleted memories)
    const orphans = agentId
      ? db.prepare(
        `DELETE FROM paths
         WHERE agent_id = ?
           AND memory_id NOT IN (SELECT id FROM memories WHERE agent_id = ?)`,
      ).run(agentId, agentId)
      : db.prepare(
        "DELETE FROM paths WHERE memory_id NOT IN (SELECT id FROM memories)",
      ).run();
    orphansCleaned = orphans.changes;
  });

  transaction();

  return { archived, orphansCleaned };
}
