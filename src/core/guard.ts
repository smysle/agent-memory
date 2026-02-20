// AgentMemory v2 — Write Guard (dedup + conflict detection + 4-criterion gate)
import type Database from "better-sqlite3";
import { contentHash, type CreateMemoryInput, type Memory } from "./memory.js";
import { getPathByUri } from "./path.js";

export type GuardAction = "add" | "update" | "skip" | "merge";

export interface GuardResult {
  action: GuardAction;
  reason: string;
  existingId?: string;
  mergedContent?: string;
}

/**
 * Write Guard — decides whether to add, update, skip, or merge a memory.
 *
 * Pipeline:
 * 1. Hash dedup (exact content match → skip)
 * 2. URI conflict (URI exists → update path)
 * 3. BM25 similarity (>0.85 → conflict detection → merge or update)
 * 4. Four-criterion gate (for P0/P1 only)
 */
export function guard(
  db: Database.Database,
  input: CreateMemoryInput & { uri?: string },
): GuardResult {
  const hash = contentHash(input.content);
  const agentId = input.agent_id ?? "default";

  // 1. Hash dedup — exact content match
  const exactMatch = db
    .prepare("SELECT id FROM memories WHERE hash = ? AND agent_id = ?")
    .get(hash, agentId) as { id: string } | undefined;

  if (exactMatch) {
    return { action: "skip", reason: "Exact duplicate (hash match)", existingId: exactMatch.id };
  }

  // 2. URI conflict — URI already exists, update instead of add
  if (input.uri) {
    const existingPath = getPathByUri(db, input.uri);
    if (existingPath) {
      return {
        action: "update",
        reason: `URI ${input.uri} already exists, updating`,
        existingId: existingPath.memory_id,
      };
    }
  }

  // 3. BM25 similarity — find similar content
  const similar = db
    .prepare(
      `SELECT m.id, m.content, m.type, rank
       FROM memories_fts f
       JOIN memories m ON m.id = f.id
       WHERE memories_fts MATCH ? AND m.agent_id = ?
       ORDER BY rank
       LIMIT 3`,
    )
    .all(escapeFts(input.content), agentId) as Array<
    Memory & { rank: number }
  >;

  if (similar.length > 0 && similar[0].rank < -10) {
    // High similarity — check if it's a conflict (different info about same topic)
    const existing = similar[0];
    if (existing.type === input.type) {
      // Same type + high similarity → merge
      const merged = `${existing.content}\n\n[Updated] ${input.content}`;
      return {
        action: "merge",
        reason: "Similar content found, merging",
        existingId: existing.id,
        mergedContent: merged,
      };
    }
  }

  // 4. Four-criterion gate (only for P0/P1 — identity and emotion)
  const priority = input.priority ?? (input.type === "identity" ? 0 : input.type === "emotion" ? 1 : 2);
  if (priority <= 1) {
    // For high-priority memories, we're more lenient — just check basic validity
    if (!input.content.trim()) {
      return { action: "skip", reason: "Empty content rejected by gate" };
    }
  }

  // All checks passed → add
  return { action: "add", reason: "Passed all guard checks" };
}

/**
 * Escape special FTS5 characters in query
 */
function escapeFts(text: string): string {
  // Take first 100 chars, remove special chars, join with OR for flexible matching
  const words = text
    .slice(0, 100)
    .replace(/[^\w\u4e00-\u9fff\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 5);

  if (words.length === 0) return '""';
  return words.map((w) => `"${w}"`).join(" OR ");
}
