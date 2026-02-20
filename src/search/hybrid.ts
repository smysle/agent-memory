// AgentMemory v2 — Hybrid search (BM25 + Embeddings + RRF)
import type Database from "better-sqlite3";
import type { Memory } from "../core/memory.js";
import { searchBM25, type SearchResult } from "./bm25.js";
import { listEmbeddings } from "./embeddings.js";
import type { EmbeddingProvider } from "./providers.js";

export interface HybridSearchOptions {
  agent_id?: string;
  limit?: number;
  bm25CandidateMultiplier?: number; // default 3
  semanticCandidates?: number; // default 50
  rrfK?: number; // default 60
  embeddingProvider?: EmbeddingProvider | null;
  embeddingModel?: string;
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function rrfScore(rank: number, k: number): number {
  return 1.0 / (k + rank);
}

function fuseRrf(
  lists: Array<{ name: string; items: Array<{ id: string; score: number }> }>,
  k: number,
): Map<string, { score: number; sources: string[] }> {
  const out = new Map<string, { score: number; sources: string[] }>();
  for (const list of lists) {
    for (let i = 0; i < list.items.length; i++) {
      const it = list.items[i]!;
      const rank = i + 1;
      const add = rrfScore(rank, k);
      const prev = out.get(it.id);
      if (!prev) out.set(it.id, { score: add, sources: [list.name] });
      else {
        prev.score += add;
        if (!prev.sources.includes(list.name)) prev.sources.push(list.name);
      }
    }
  }
  return out;
}

function fetchMemories(db: Database.Database, ids: string[], agentId?: string): Memory[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const sql = agentId
    ? `SELECT * FROM memories WHERE id IN (${placeholders}) AND agent_id = ?`
    : `SELECT * FROM memories WHERE id IN (${placeholders})`;
  const rows = db.prepare(sql).all(...(agentId ? [...ids, agentId] : ids)) as Memory[];
  return rows;
}

export async function searchHybrid(
  db: Database.Database,
  query: string,
  opts?: HybridSearchOptions,
): Promise<SearchResult[]> {
  const agentId = opts?.agent_id ?? "default";
  const limit = opts?.limit ?? 10;
  const bm25Mult = opts?.bm25CandidateMultiplier ?? 3;
  const semanticCandidates = opts?.semanticCandidates ?? 50;
  const rrfK = opts?.rrfK ?? 60;

  const bm25 = searchBM25(db, query, {
    agent_id: agentId,
    limit: limit * bm25Mult,
  });

  const provider = opts?.embeddingProvider ?? null;
  const model = opts?.embeddingModel ?? provider?.model;
  if (!provider || !model) {
    return bm25.slice(0, limit);
  }

  // Semantic retrieval: brute-force cosine over stored embeddings for the agent.
  const qVec = Float32Array.from(await provider.embed(query));
  const embeddings = listEmbeddings(db, agentId, model);

  const scored: Array<{ id: string; score: number }> = [];
  for (const e of embeddings) {
    scored.push({ id: e.memory_id, score: cosine(qVec, e.vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  const semanticTop = scored.slice(0, semanticCandidates);

  const fused = fuseRrf(
    [
      { name: "bm25", items: bm25.map((r) => ({ id: r.memory.id, score: r.score })) },
      { name: "semantic", items: semanticTop },
    ],
    rrfK,
  );

  const ids = [...fused.keys()];
  const memories = fetchMemories(db, ids, agentId);
  const byId = new Map(memories.map((m) => [m.id, m]));

  const out: SearchResult[] = [];
  for (const [id, meta] of fused) {
    const mem = byId.get(id);
    if (!mem) continue;
    out.push({
      memory: mem,
      score: meta.score,
      matchReason: meta.sources.sort().join("+"),
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
