import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../search/embedding.js";
import { recallMemories, type HybridRecallResponse } from "../search/hybrid.js";
import { recordPassiveFeedback } from "./feedback.js";

export interface RecallInput {
  query: string;
  limit?: number;
  agent_id?: string;
  min_vitality?: number;
  lexicalLimit?: number;
  vectorLimit?: number;
  provider?: EmbeddingProvider | null;
  recordAccess?: boolean;
  emotion_tag?: string;
  related?: boolean;
  after?: string;
  before?: string;
  recency_boost?: number;
}

export async function recallMemory(
  db: Database.Database,
  input: RecallInput,
): Promise<HybridRecallResponse> {
  const result = await recallMemories(db, input.query, {
    agent_id: input.agent_id,
    limit: input.emotion_tag ? (input.limit ?? 10) * 3 : input.limit,
    min_vitality: input.min_vitality,
    lexicalLimit: input.lexicalLimit,
    vectorLimit: input.vectorLimit,
    provider: input.provider,
    recordAccess: input.recordAccess,
    related: input.related,
    after: input.after,
    before: input.before,
    recency_boost: input.recency_boost,
  });

  // Post-filter by emotion_tag if specified
  if (input.emotion_tag) {
    result.results = result.results
      .filter((r) => (r.memory as typeof r.memory & { emotion_tag?: string }).emotion_tag === input.emotion_tag)
      .slice(0, input.limit ?? 10);
  }

  // Record passive feedback for top-3 direct results
  if (input.recordAccess !== false) {
    const top3DirectIds = result.results
      .filter((r) => r.match_type !== "related")
      .slice(0, 3)
      .map((r) => r.memory.id);
    if (top3DirectIds.length > 0) {
      recordPassiveFeedback(db, top3DirectIds, input.agent_id);
    }
  }

  return result;
}
