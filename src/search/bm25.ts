// AgentMemory v2 — BM25 full-text search via SQLite FTS5
import type Database from "better-sqlite3";
import type { Memory } from "../core/memory.js";

export interface SearchResult {
  memory: Memory;
  score: number;
  matchReason: string;
}

/**
 * BM25 search using SQLite FTS5.
 * Returns memories ranked by relevance.
 */
export function searchBM25(
  db: Database.Database,
  query: string,
  opts?: {
    agent_id?: string;
    limit?: number;
    min_vitality?: number;
  },
): SearchResult[] {
  const limit = opts?.limit ?? 20;
  const agentId = opts?.agent_id ?? "default";
  const minVitality = opts?.min_vitality ?? 0.0;

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    const rows = db
      .prepare(
        `SELECT m.*, rank AS score
         FROM memories_fts f
         JOIN memories m ON m.id = f.id
         WHERE memories_fts MATCH ?
           AND m.agent_id = ?
           AND m.vitality >= ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, agentId, minVitality, limit) as Array<Memory & { score: number }>;

    return rows.map((row) => ({
      memory: { ...row, score: undefined } as unknown as Memory,
      score: Math.abs(row.score), // FTS5 rank is negative (lower = better)
      matchReason: "bm25",
    }));
  } catch {
    // FTS query syntax error — fall back to simpler query
    return searchSimple(db, query, agentId, minVitality, limit);
  }
}

/**
 * Simple LIKE search as fallback when FTS fails
 */
function searchSimple(
  db: Database.Database,
  query: string,
  agentId: string,
  minVitality: number,
  limit: number,
): SearchResult[] {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE agent_id = ? AND vitality >= ? AND content LIKE ?
       ORDER BY priority ASC, updated_at DESC
       LIMIT ?`,
    )
    .all(agentId, minVitality, `%${query}%`, limit) as Memory[];

  return rows.map((m, i) => ({
    memory: m,
    score: 1.0 / (i + 1), // Simple rank by position
    matchReason: "like",
  }));
}

/**
 * Build FTS5 query from natural language.
 * Extracts meaningful words, joins with OR for flexible matching.
 */
function buildFtsQuery(text: string): string | null {
  const words = text
    .replace(/[^\w\u4e00-\u9fff\u3040-\u30ff\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 10);

  if (words.length === 0) return null;

  // Use OR for broad matching
  return words.map((w) => `"${w}"`).join(" OR ");
}
