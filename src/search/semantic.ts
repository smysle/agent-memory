// AgentMemory v2 — Optional semantic search interface
// Allows plugging in external embedding providers (OpenAI, local models, etc.)

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimension: number;
}

/**
 * Placeholder for semantic search.
 * In v2, BM25 is the primary search engine.
 * Semantic search can be added later by implementing EmbeddingProvider.
 */
export function createSemanticSearch(_provider?: EmbeddingProvider) {
  // TODO: Phase 2.5 — add vector column to memories + cosine similarity
  return {
    available: false as const,
    search: async (_query: string, _limit: number) => {
      return [] as Array<{ id: string; score: number }>;
    },
  };
}
