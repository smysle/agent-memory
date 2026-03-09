import type Database from "better-sqlite3";
import type { Memory } from "../core/memory.js";
import { recordAccess } from "../core/memory.js";
import { searchBM25, rebuildBm25Index, type SearchResult } from "./bm25.js";
import type { EmbeddingProvider } from "./embedding.js";
import { getEmbeddingProviderFromEnv } from "./providers.js";
import {
  markEmbeddingFailed,
  markMemoryEmbeddingPending,
  searchByVector,
  type VectorSearchResult,
  upsertReadyEmbedding,
} from "./vector.js";

export interface HybridRecallResult {
  memory: Memory;
  score: number;
  bm25_rank?: number;
  vector_rank?: number;
  bm25_score?: number;
  vector_score?: number;
}

export interface HybridRecallResponse {
  mode: "bm25-only" | "vector-only" | "dual-path";
  providerId: string | null;
  usedVectorSearch: boolean;
  results: HybridRecallResult[];
}

export interface RecallOptions {
  agent_id?: string;
  limit?: number;
  min_vitality?: number;
  lexicalLimit?: number;
  vectorLimit?: number;
  provider?: EmbeddingProvider | null;
  recordAccess?: boolean;
}

export interface ReindexOptions {
  agent_id?: string;
  provider?: EmbeddingProvider | null;
  force?: boolean;
  batchSize?: number;
}

export interface ReindexEmbeddingsResult {
  enabled: boolean;
  providerId: string | null;
  scanned: number;
  pending: number;
  embedded: number;
  failed: number;
}

export interface ReindexSearchResult {
  fts: { reindexed: number };
  embeddings: ReindexEmbeddingsResult;
}

const PRIORITY_WEIGHT: Record<number, number> = {
  0: 4.0,
  1: 3.0,
  2: 2.0,
  3: 1.0,
};

const PRIORITY_PRIOR: Record<number, number> = {
  0: 1.0,
  1: 0.75,
  2: 0.5,
  3: 0.25,
};

function scoreBm25Only(results: SearchResult[], limit: number): HybridRecallResult[] {
  return results
    .map((row) => {
      const weight = PRIORITY_WEIGHT[row.memory.priority] ?? 1.0;
      const vitality = Math.max(0.1, row.memory.vitality);
      return {
        memory: row.memory,
        score: row.score * weight * vitality,
        bm25_rank: row.rank,
        bm25_score: row.score,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function priorityPrior(priority: number): number {
  return PRIORITY_PRIOR[priority] ?? 0.25;
}

export function fusionScore(input: {
  memory: Memory;
  bm25Rank?: number;
  vectorRank?: number;
}): number {
  const lexical = input.bm25Rank ? 0.45 / (60 + input.bm25Rank) : 0;
  const semantic = input.vectorRank ? 0.45 / (60 + input.vectorRank) : 0;
  return lexical + semantic + 0.05 * priorityPrior(input.memory.priority) + 0.05 * input.memory.vitality;
}

export function fuseHybridResults(
  lexical: SearchResult[],
  vector: VectorSearchResult[],
  limit: number,
): HybridRecallResult[] {
  const candidates = new Map<string, HybridRecallResult>();

  for (const row of lexical) {
    candidates.set(row.memory.id, {
      memory: row.memory,
      score: 0,
      bm25_rank: row.rank,
      bm25_score: row.score,
    });
  }

  for (const row of vector) {
    const existing = candidates.get(row.memory.id);
    if (existing) {
      existing.vector_rank = row.rank;
      existing.vector_score = row.similarity;
    } else {
      candidates.set(row.memory.id, {
        memory: row.memory,
        score: 0,
        vector_rank: row.rank,
        vector_score: row.similarity,
      });
    }
  }

  return [...candidates.values()]
    .map((row) => ({
      ...row,
      score: fusionScore({ memory: row.memory, bm25Rank: row.bm25_rank, vectorRank: row.vector_rank }),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.memory.updated_at.localeCompare(left.memory.updated_at);
    })
    .slice(0, limit);
}

async function searchVectorBranch(
  db: Database.Database,
  query: string,
  opts: {
    provider: EmbeddingProvider;
    agent_id: string;
    limit: number;
    min_vitality: number;
  },
): Promise<VectorSearchResult[]> {
  const [queryVector] = await opts.provider.embed([query]);
  if (!queryVector) return [];
  return searchByVector(db, queryVector, {
    providerId: opts.provider.id,
    agent_id: opts.agent_id,
    limit: opts.limit,
    min_vitality: opts.min_vitality,
  });
}

export async function recallMemories(
  db: Database.Database,
  query: string,
  opts?: RecallOptions,
): Promise<HybridRecallResponse> {
  const limit = opts?.limit ?? 10;
  const agentId = opts?.agent_id ?? "default";
  const minVitality = opts?.min_vitality ?? 0;
  const lexicalLimit = opts?.lexicalLimit ?? Math.max(limit * 2, limit);
  const vectorLimit = opts?.vectorLimit ?? Math.max(limit * 2, limit);
  const provider = opts?.provider === undefined ? getEmbeddingProviderFromEnv() : opts.provider;

  const lexical = searchBM25(db, query, {
    agent_id: agentId,
    limit: lexicalLimit,
    min_vitality: minVitality,
  });

  let vector: VectorSearchResult[] = [];
  if (provider) {
    try {
      vector = await searchVectorBranch(db, query, {
        provider,
        agent_id: agentId,
        limit: vectorLimit,
        min_vitality: minVitality,
      });
    } catch {
      vector = [];
    }
  }

  const mode = vector.length > 0 && lexical.length > 0
    ? "dual-path"
    : vector.length > 0
      ? "vector-only"
      : "bm25-only";

  const results = mode === "bm25-only"
    ? scoreBm25Only(lexical, limit)
    : fuseHybridResults(lexical, vector, limit);

  if (opts?.recordAccess !== false) {
    for (const row of results) {
      recordAccess(db, row.memory.id);
    }
  }

  return {
    mode,
    providerId: provider?.id ?? null,
    usedVectorSearch: vector.length > 0,
    results,
  };
}

interface ReindexCandidate {
  memoryId: string;
  content: string;
  contentHash: string;
}

function listReindexCandidates(
  db: Database.Database,
  providerId: string,
  agentId: string,
  force: boolean,
): ReindexCandidate[] {
  const rows = db.prepare(
    `SELECT m.id as memoryId,
            m.content as content,
            m.hash as contentHash,
            e.status as embeddingStatus,
            e.content_hash as embeddingHash
     FROM memories m
     LEFT JOIN embeddings e
       ON e.memory_id = m.id
      AND e.provider_id = ?
     WHERE m.agent_id = ?
       AND m.hash IS NOT NULL`,
  ).all(providerId, agentId) as Array<{
    memoryId: string;
    content: string;
    contentHash: string;
    embeddingStatus?: string | null;
    embeddingHash?: string | null;
  }>;

  return rows
    .filter((row) => {
      if (force) return true;
      if (!row.embeddingStatus) return true;
      if (row.embeddingStatus !== "ready") return true;
      return row.embeddingHash !== row.contentHash;
    })
    .map((row) => ({
      memoryId: row.memoryId,
      content: row.content,
      contentHash: row.contentHash,
    }));
}

export async function reindexEmbeddings(
  db: Database.Database,
  opts?: ReindexOptions,
): Promise<ReindexEmbeddingsResult> {
  const provider = opts?.provider === undefined ? getEmbeddingProviderFromEnv() : opts.provider;
  if (!provider) {
    return {
      enabled: false,
      providerId: null,
      scanned: 0,
      pending: 0,
      embedded: 0,
      failed: 0,
    };
  }

  const agentId = opts?.agent_id ?? "default";
  const force = opts?.force ?? false;
  const batchSize = Math.max(1, opts?.batchSize ?? 16);
  const candidates = listReindexCandidates(db, provider.id, agentId, force);

  for (const candidate of candidates) {
    markMemoryEmbeddingPending(db, candidate.memoryId, provider.id, candidate.contentHash);
  }

  let embedded = 0;
  let failed = 0;

  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    try {
      const vectors = await provider.embed(batch.map((row) => row.content));
      if (vectors.length !== batch.length) {
        throw new Error(`Expected ${batch.length} embeddings, received ${vectors.length}`);
      }
      for (let offset = 0; offset < batch.length; offset++) {
        upsertReadyEmbedding({
          db,
          memoryId: batch[offset].memoryId,
          providerId: provider.id,
          vector: vectors[offset],
          contentHash: batch[offset].contentHash,
        });
        embedded += 1;
      }
    } catch {
      for (const candidate of batch) {
        markEmbeddingFailed(db, candidate.memoryId, provider.id, candidate.contentHash);
        failed += 1;
      }
    }
  }

  return {
    enabled: true,
    providerId: provider.id,
    scanned: candidates.length,
    pending: candidates.length,
    embedded,
    failed,
  };
}

export async function reindexMemorySearch(
  db: Database.Database,
  opts?: ReindexOptions,
): Promise<ReindexSearchResult> {
  const fts = rebuildBm25Index(db, { agent_id: opts?.agent_id });
  const embeddings = await reindexEmbeddings(db, opts);
  return { fts, embeddings };
}
