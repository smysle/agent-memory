// AgentMemory v2 — Search result reranking + priority weighting
import type { SearchResult } from "./bm25.js";
import type { SearchIntent } from "./intent.js";
import type { RerankProvider } from "./rerank-provider.js";

/**
 * Optionally rerank results using an external semantic reranker provider.
 * Best-effort: on failure, returns original results unchanged.
 */
export async function rerankWithProvider(
  results: SearchResult[],
  query: string,
  provider: RerankProvider,
): Promise<SearchResult[]> {
  if (results.length === 0) return results;

  const documents = results.map((r) => r.memory.content);

  try {
    const apiResults = await provider.rerank(query, documents);
    const scoreMap = new Map(apiResults.map((r) => [r.index, r.relevance_score]));

    return results.map((r, i) => {
      const score = scoreMap.get(i);
      if (score === undefined) return r;
      return {
        ...r,
        score,
        matchReason: `${r.matchReason}+rerank`,
      };
    });
  } catch (err) {
    console.warn("[agent-memory] External rerank failed, falling back:", err);
    return results;
  }
}

/**
 * Rerank search results based on intent strategy and priority weighting.
 */
export function rerank(
  results: SearchResult[],
  opts: {
    intent?: SearchIntent;
    boostRecent: boolean;
    boostPriority: boolean;
    limit: number;
  },
): SearchResult[] {
  const now = Date.now();

  const scored = results.map((r) => {
    let finalScore = r.score;

    // Priority boost: P0 > P1 > P2 > P3
    if (opts.boostPriority) {
      const priorityMultiplier = [4.0, 3.0, 2.0, 1.0][r.memory.priority] ?? 1.0;
      finalScore *= priorityMultiplier;
    }

    // Recency boost for temporal queries
    if (opts.boostRecent && r.memory.updated_at) {
      const age = now - new Date(r.memory.updated_at).getTime();
      const daysSinceUpdate = age / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.max(0.1, 1.0 / (1.0 + daysSinceUpdate * 0.1));
      finalScore *= recencyBoost;
    }

    // Vitality factor — higher vitality memories are more relevant
    finalScore *= Math.max(0.1, r.memory.vitality);

    return { ...r, score: finalScore };
  });

  // Sort by final score (descending)
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, opts.limit);
}
