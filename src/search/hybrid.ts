import type Database from "better-sqlite3";
import type { Memory } from "../core/memory.js";
import { recordAccess } from "../core/memory.js";
import { searchBM25, rebuildBm25Index, type SearchResult } from "./bm25.js";
import type { EmbeddingProvider } from "./embedding.js";
import { getEmbeddingProviderFromEnv, getEmbeddingProviderManager } from "./providers.js";
import {
  markEmbeddingFailed,
  markMemoryEmbeddingPending,
  resetVectorSidecar,
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
  related_source_id?: string;
  match_type?: "direct" | "related";
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
  related?: boolean;
  after?: string;
  before?: string;
  recency_boost?: number;
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
  providerIds?: string[];
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
  recency_boost?: number;
}): number {
  const lexical = input.bm25Rank ? 0.45 / (60 + input.bm25Rank) : 0;
  const semantic = input.vectorRank ? 0.45 / (60 + input.vectorRank) : 0;
  const baseScore = lexical + semantic + 0.05 * priorityPrior(input.memory.priority) + 0.05 * input.memory.vitality;

  const boost = input.recency_boost ?? 0;
  if (boost <= 0) return baseScore;

  const updatedAt = new Date(input.memory.updated_at).getTime();
  const daysSince = Math.max(0, (Date.now() - updatedAt) / (1000 * 60 * 60 * 24));
  const recencyScore = Math.exp(-daysSince / 30);
  return (1 - boost) * baseScore + boost * recencyScore;
}

export function fuseHybridResults(
  lexical: SearchResult[],
  vector: VectorSearchResult[],
  limit: number,
  recency_boost?: number,
): HybridRecallResult[] {
  const candidates = new Map<string, HybridRecallResult>();

  for (const row of lexical) {
    candidates.set(row.memory.id, {
      memory: row.memory,
      score: 0,
      bm25_rank: row.rank,
      bm25_score: row.score,
      match_type: "direct",
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
        match_type: "direct",
      });
    }
  }

  return [...candidates.values()]
    .map((row) => ({
      ...row,
      score: fusionScore({ memory: row.memory, bm25Rank: row.bm25_rank, vectorRank: row.vector_rank, recency_boost }),
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
    manager?: ReturnType<typeof getEmbeddingProviderManager> | null;
    agent_id: string;
    limit: number;
    min_vitality: number;
    after?: string;
    before?: string;
  },
): Promise<{ providerId: string; results: VectorSearchResult[] }> {
  const result = opts.manager
    ? await opts.manager.embedWithFailover([query])
    : { provider: opts.provider, vectors: await opts.provider.embed([query]) };
  const [queryVector] = result.vectors;
  if (!queryVector) {
    return { providerId: result.provider.id, results: [] };
  }
  return {
    providerId: result.provider.id,
    results: searchByVector(db, queryVector, {
      providerId: result.provider.id,
      agent_id: opts.agent_id,
      limit: opts.limit,
      min_vitality: opts.min_vitality,
      after: opts.after,
      before: opts.before,
    }),
  };
}

export interface RelatedLink {
  memory: Memory;
  sourceId: string;
  weight: number;
}

/**
 * Fetch related memories from the links table for a set of source memory IDs.
 * Shared by both recall and surface expansion paths.
 */
export function fetchRelatedLinks(
  db: Database.Database,
  sourceIds: string[],
  agentId: string,
  excludeIds: Set<string>,
  maxPerSource = 5,
): RelatedLink[] {
  const related: RelatedLink[] = [];

  for (const sourceId of sourceIds) {
    const links = db.prepare(
      `SELECT l.target_id, l.weight, m.*
       FROM links l
       JOIN memories m ON m.id = l.target_id
       WHERE l.agent_id = ? AND l.source_id = ?
       ORDER BY l.weight DESC
       LIMIT ?`,
    ).all(agentId, sourceId, maxPerSource) as Array<{ target_id: string; weight: number } & Memory>;

    for (const link of links) {
      if (excludeIds.has(link.target_id)) continue;
      excludeIds.add(link.target_id);

      const relatedMemory: Memory = {
        id: link.id,
        content: link.content,
        type: link.type,
        priority: link.priority,
        emotion_val: link.emotion_val,
        vitality: link.vitality,
        stability: link.stability,
        access_count: link.access_count,
        last_accessed: link.last_accessed,
        created_at: link.created_at,
        updated_at: link.updated_at,
        source: link.source,
        agent_id: link.agent_id,
        hash: link.hash,
        emotion_tag: link.emotion_tag,
        source_session: (link as unknown as Record<string, unknown>).source_session as string | null ?? null,
        source_context: (link as unknown as Record<string, unknown>).source_context as string | null ?? null,
        observed_at: (link as unknown as Record<string, unknown>).observed_at as string | null ?? null,
      };

      related.push({
        memory: relatedMemory,
        sourceId,
        weight: link.weight,
      });
    }
  }

  return related;
}

/**
 * Expand results with related memories from the links table.
 * For each result in the top-K, query links and add related memories.
 */
function expandRelated(
  db: Database.Database,
  results: HybridRecallResult[],
  agentId: string,
  maxTotal: number,
): HybridRecallResult[] {
  const existingIds = new Set(results.map((r) => r.memory.id));

  const links = fetchRelatedLinks(
    db,
    results.map((r) => r.memory.id),
    agentId,
    existingIds,
  );

  const related: HybridRecallResult[] = links.map((link) => {
    const sourceResult = results.find((r) => r.memory.id === link.sourceId);
    return {
      memory: link.memory,
      score: (sourceResult?.score ?? 0) * link.weight * 0.6,
      related_source_id: link.sourceId,
      match_type: "related" as const,
    };
  });

  // Mark direct results
  const directResults = results.map((r) => ({
    ...r,
    match_type: "direct" as const,
  }));

  // Combine and limit
  const combined = [...directResults, ...related]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTotal);

  return combined;
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
  const providerManager = opts?.provider === undefined ? getEmbeddingProviderManager() : null;
  const provider = opts?.provider === undefined ? providerManager?.getActiveProvider() ?? null : opts.provider;
  const recencyBoost = opts?.recency_boost;
  const after = opts?.after;
  const before = opts?.before;

  const lexical = searchBM25(db, query, {
    agent_id: agentId,
    limit: lexicalLimit,
    min_vitality: minVitality,
    after,
    before,
  });

  let vector: VectorSearchResult[] = [];
  let vectorProviderId: string | null = provider?.id ?? null;
  if (provider) {
    try {
      const vectorBranch = await searchVectorBranch(db, query, {
        provider,
        manager: providerManager,
        agent_id: agentId,
        limit: vectorLimit,
        min_vitality: minVitality,
        after,
        before,
      });
      vector = vectorBranch.results;
      vectorProviderId = vectorBranch.providerId;
    } catch {
      vector = [];
    }
  }

  const mode = vector.length > 0 && lexical.length > 0
    ? "dual-path"
    : vector.length > 0
      ? "vector-only"
      : "bm25-only";

  let results = mode === "bm25-only"
    ? scoreBm25Only(lexical, limit)
    : fuseHybridResults(lexical, vector, limit, recencyBoost);

  // Expand related if requested
  if (opts?.related) {
    const maxTotal = Math.floor(limit * 1.5);
    results = expandRelated(db, results, agentId, maxTotal);
  }

  if (opts?.recordAccess !== false) {
    for (const row of results) {
      if (row.match_type !== "related") {
        recordAccess(db, row.memory.id);
      }
    }
  }

  return {
    mode,
    providerId: vectorProviderId,
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
  agentId: string,
): ReindexCandidate[] {
  return db.prepare(
    `SELECT id as memoryId,
            content as content,
            hash as contentHash
     FROM memories
     WHERE agent_id = ?
       AND hash IS NOT NULL`,
  ).all(agentId) as ReindexCandidate[];
}

export async function reindexEmbeddings(
  db: Database.Database,
  opts?: ReindexOptions,
): Promise<ReindexEmbeddingsResult> {
  const providerManager = opts?.provider === undefined ? getEmbeddingProviderManager() : null;
  const providers = opts?.provider
    ? [opts.provider]
    : providerManager?.listProviders() ?? [];

  if (providers.length === 0) {
    return {
      enabled: false,
      providerId: null,
      providerIds: [],
      scanned: 0,
      pending: 0,
      embedded: 0,
      failed: 0,
    };
  }

  const agentId = opts?.agent_id ?? "default";
  const force = opts?.force ?? false;
  const batchSize = Math.max(1, opts?.batchSize ?? 16);
  let scanned = 0;
  let pending = 0;
  let embedded = 0;
  let failed = 0;

  for (const provider of providers) {
    if (force) {
      resetVectorSidecar(db, provider.id);
    }

    const candidates = listReindexCandidates(db, agentId);

    scanned += candidates.length;
    pending += candidates.length;

    for (const candidate of candidates) {
      markMemoryEmbeddingPending(db, candidate.memoryId, provider.id, candidate.contentHash);
    }

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
  }

  return {
    enabled: true,
    providerId: providers[0]?.id ?? null,
    providerIds: providers.map((provider) => provider.id),
    scanned,
    pending,
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
