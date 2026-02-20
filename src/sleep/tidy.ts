// AgentMemory v2 — Sleep tidy engine (deep sleep phase)
// Compresses, distills, archives old memories
import type Database from "better-sqlite3";
import { deleteMemory, listMemories, type Memory } from "../core/memory.js";
import { createSnapshot } from "../core/snapshot.js";
import { getDecayedMemories } from "./decay.js";

export interface TidyResult {
  archived: number;
  orphansCleaned: number;
  snapshotsPruned: number;
}

/**
 * Run the tidy (deep sleep) cycle:
 * 1. Archive decayed P3 memories (vitality < threshold)
 * 2. Clean orphan paths (paths with no memory)
 * 3. Prune old snapshots (keep last N per memory)
 */
export function runTidy(
  db: Database.Database,
  opts?: {
    vitalityThreshold?: number;
    maxSnapshotsPerMemory?: number;
  },
): TidyResult {
  const threshold = opts?.vitalityThreshold ?? 0.05;
  const maxSnapshots = opts?.maxSnapshotsPerMemory ?? 10;

  let archived = 0;
  let orphansCleaned = 0;
  let snapshotsPruned = 0;

  const transaction = db.transaction(() => {
    // 1. Archive decayed memories
    const decayed = getDecayedMemories(db, threshold);
    for (const mem of decayed) {
      // Snapshot before delete
      try {
        createSnapshot(db, mem.id, "delete", "tidy");
      } catch {
        // Memory might already be gone
      }
      deleteMemory(db, mem.id);
      archived++;
    }

    // 2. Clean orphan paths (paths pointing to deleted memories)
    const orphans = db
      .prepare(
        `DELETE FROM paths WHERE memory_id NOT IN (SELECT id FROM memories)`,
      )
      .run();
    orphansCleaned = orphans.changes;

    // 3. Prune old snapshots (keep only latest N per memory)
    const memoriesWithSnapshots = db
      .prepare(
        `SELECT memory_id, COUNT(*) as cnt FROM snapshots
         GROUP BY memory_id HAVING cnt > ?`,
      )
      .all(maxSnapshots) as Array<{ memory_id: string; cnt: number }>;

    for (const { memory_id } of memoriesWithSnapshots) {
      const pruned = db
        .prepare(
          `DELETE FROM snapshots WHERE id NOT IN (
            SELECT id FROM snapshots WHERE memory_id = ?
            ORDER BY created_at DESC LIMIT ?
          ) AND memory_id = ?`,
        )
        .run(memory_id, maxSnapshots, memory_id);
      snapshotsPruned += pruned.changes;
    }
  });

  transaction();

  return { archived, orphansCleaned, snapshotsPruned };
}
