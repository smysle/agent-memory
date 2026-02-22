// AgentMemory v2 — Main library entry point

// Core
export { openDatabase, isCountRow, type DbOptions } from "./core/db.js";
export {
  createMemory, getMemory, updateMemory, deleteMemory, listMemories,
  recordAccess, countMemories, contentHash,
  type Memory, type MemoryType, type Priority, type CreateMemoryInput, type UpdateMemoryInput,
} from "./core/memory.js";
export {
  createPath, getPath, getPathByUri, getPathsByMemory, getPathsByDomain, getPathsByPrefix,
  deletePath, parseUri, type Path,
} from "./core/path.js";
export {
  createLink, getLinks, getOutgoingLinks, traverse, deleteLink,
  type Link, type RelationType,
} from "./core/link.js";
export {
  createSnapshot, getSnapshots, getSnapshot, rollback,
  type Snapshot, type SnapshotAction,
} from "./core/snapshot.js";
export { guard, type GuardResult, type GuardAction } from "./core/guard.js";
export { exportMemories, type ExportResult } from "./core/export.js";

// Search
export { searchBM25, type SearchResult } from "./search/bm25.js";
export { tokenize } from "./search/tokenizer.js";
export { classifyIntent, getStrategy, type SearchIntent, type IntentResult } from "./search/intent.js";
export { rerank, rerankWithProvider } from "./search/rerank.js";
export { searchHybrid, type HybridSearchOptions } from "./search/hybrid.js";
export { upsertEmbedding, getEmbedding, listEmbeddings, encodeEmbedding, decodeEmbedding, type StoredEmbedding } from "./search/embeddings.js";
export { getEmbeddingProviderFromEnv, getDefaultInstruction, createOpenAIProvider, createDashScopeProvider, type EmbeddingProvider } from "./search/providers.js";
export {
  getRerankerProviderFromEnv,
  createOpenAIRerankProvider,
  type RerankProvider,
  type RerankResult,
} from "./search/rerank-provider.js";
export { embedMemory, embedMissingForAgent } from "./search/embed.js";

// Sleep
export { calculateVitality, runDecay, getDecayedMemories } from "./sleep/decay.js";
export { syncOne, syncBatch, type SyncInput, type SyncResult } from "./sleep/sync.js";
export { runTidy, type TidyResult } from "./sleep/tidy.js";
export { runGovern, type GovernResult } from "./sleep/govern.js";
export { boot, type BootResult } from "./sleep/boot.js";
