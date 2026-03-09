import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../search/embedding.js";
import { rebuildBm25Index } from "../search/bm25.js";
import {
  reindexEmbeddings,
  type ReindexEmbeddingsResult,
  type ReindexSearchResult,
} from "../search/hybrid.js";

export interface ReindexProgressEvent {
  status: "started" | "stage-completed" | "completed" | "failed";
  stage: "fts" | "embeddings" | "done";
  progress: number;
  detail?: unknown;
}

export interface ReindexInput {
  agent_id?: string;
  provider?: EmbeddingProvider | null;
  force?: boolean;
  batchSize?: number;
  onProgress?: (event: ReindexProgressEvent) => void;
}

export async function reindexMemories(
  db: Database.Database,
  input?: ReindexInput,
): Promise<ReindexSearchResult> {
  input?.onProgress?.({ status: "started", stage: "fts", progress: 0 });

  try {
    const fts = rebuildBm25Index(db, { agent_id: input?.agent_id });
    input?.onProgress?.({
      status: "stage-completed",
      stage: "fts",
      progress: 0.5,
      detail: fts,
    });

    const embeddings: ReindexEmbeddingsResult = await reindexEmbeddings(db, {
      agent_id: input?.agent_id,
      provider: input?.provider,
      force: input?.force,
      batchSize: input?.batchSize,
    });

    input?.onProgress?.({
      status: "stage-completed",
      stage: "embeddings",
      progress: 0.9,
      detail: embeddings,
    });

    const result = { fts, embeddings };
    input?.onProgress?.({
      status: "completed",
      stage: "done",
      progress: 1,
      detail: result,
    });
    return result;
  } catch (error) {
    input?.onProgress?.({
      status: "failed",
      stage: "done",
      progress: 1,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
