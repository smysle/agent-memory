// AgentMemory v2 — Ebbinghaus forgetting curve decay engine
// From PowerMem's cognitive science approach: R = e^(-t/S)
import type Database from "better-sqlite3";
import { now } from "../core/db.js";

/**
 * Ebbinghaus forgetting curve: R = e^(-t/S)
 * R = retention (vitality), range [0, 1]
 * t = time elapsed (days)
 * S = stability (increases with each recall)
 *
 * Priority-based minimum vitality:
 * P0 (identity): never decays (min 1.0)
 * P1 (emotion):  min 0.3
 * P2 (knowledge): min 0.1
 * P3 (event):    min 0.0 (can be cleaned up)
 */

const MIN_VITALITY: Record<number, number> = {
  0: 1.0, // P0: identity — never decays
  1: 0.3, // P1: emotion — slow decay
  2: 0.1, // P2: knowledge — normal decay
  3: 0.0, // P3: event — full decay
};

/**
 * Calculate vitality using Ebbinghaus forgetting curve.
 * @param stability - S parameter (higher = slower decay)
 * @param daysSinceLastAccess - days since last recall (or creation if never accessed)
 * @param priority - memory priority (0-3)
 */
export function calculateVitality(
  stability: number,
  daysSinceLastAccess: number,
  priority: number,
): number {
  // P0 never decays
  if (priority === 0) return 1.0;

  // Prevent division by zero
  const S = Math.max(0.01, stability);

  // R = e^(-t/S)
  // t is measured from last access (recall), matching Ebbinghaus's insight
  // that forgetting restarts from the most recent retrieval.
  const retention = Math.exp(-daysSinceLastAccess / S);

  // Apply minimum vitality based on priority
  const minVit = MIN_VITALITY[priority] ?? 0.0;
  return Math.max(minVit, retention);
}

/**
 * Run decay on all memories.
 * Updates vitality based on Ebbinghaus curve.
 * Returns count of memories updated.
 */
export function runDecay(db: Database.Database): {
  updated: number;
  decayed: number;
  belowThreshold: number;
} {
  const currentTime = now();
  const currentMs = new Date(currentTime).getTime();

  // Get all non-P0 memories, including last_accessed for proper decay timing
  const memories = db
    .prepare(
      "SELECT id, priority, stability, created_at, last_accessed, vitality FROM memories WHERE priority > 0",
    )
    .all() as Array<{
    id: string;
    priority: number;
    stability: number;
    created_at: string;
    last_accessed: string | null;
    vitality: number;
  }>;

  let updated = 0;
  let decayed = 0;
  let belowThreshold = 0;

  const updateStmt = db.prepare("UPDATE memories SET vitality = ?, updated_at = ? WHERE id = ?");

  const transaction = db.transaction(() => {
    for (const mem of memories) {
      // Use last_accessed if available, otherwise fall back to created_at.
      // This matches Ebbinghaus: forgetting starts from the last recall.
      const referenceTime = mem.last_accessed ?? mem.created_at;
      const referenceMs = new Date(referenceTime).getTime();
      const daysSince = (currentMs - referenceMs) / (1000 * 60 * 60 * 24);

      const newVitality = calculateVitality(mem.stability, daysSince, mem.priority);

      // Only update if vitality actually changed (>0.001 difference)
      if (Math.abs(newVitality - mem.vitality) > 0.001) {
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

/**
 * Get memories that are candidates for cleanup (vitality < threshold).
 * Only P3 (event) memories can be fully cleaned.
 */
export function getDecayedMemories(
  db: Database.Database,
  threshold = 0.05,
): Array<{ id: string; content: string; vitality: number; priority: number }> {
  return db
    .prepare(
      `SELECT id, content, vitality, priority FROM memories
       WHERE vitality < ? AND priority >= 3
       ORDER BY vitality ASC`,
    )
    .all(threshold) as Array<{
    id: string;
    content: string;
    vitality: number;
    priority: number;
  }>;
}
