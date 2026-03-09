import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../search/embedding.js";
import { recallMemories, type HybridRecallResponse } from "../search/hybrid.js";

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
  });

  // Post-filter by emotion_tag if specified
  if (input.emotion_tag) {
    result.results = result.results
      .filter((r) => (r.memory as typeof r.memory & { emotion_tag?: string }).emotion_tag === input.emotion_tag)
      .slice(0, input.limit ?? 10);
  }

  return result;
}
