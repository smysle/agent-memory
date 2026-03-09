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
}

export async function recallMemory(
  db: Database.Database,
  input: RecallInput,
): Promise<HybridRecallResponse> {
  return recallMemories(db, input.query, {
    agent_id: input.agent_id,
    limit: input.limit,
    min_vitality: input.min_vitality,
    lexicalLimit: input.lexicalLimit,
    vectorLimit: input.vectorLimit,
    provider: input.provider,
    recordAccess: input.recordAccess,
  });
}
