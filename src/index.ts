// AgentMemory — Main library entry point

// App
export { rememberMemory, type RememberInput } from "./app/remember.js";
export { recallMemory, type RecallInput } from "./app/recall.js";
export {
  surfaceMemories,
  type SurfaceInput,
  type SurfaceIntent,
  type SurfaceResult,
  type SurfaceResponse,
} from "./app/surface.js";
export {
  reflectMemories,
  type ReflectInput as AppReflectInput,
  type ReflectProgressEvent as AppReflectProgressEvent,
} from "./app/reflect.js";
export { getMemoryStatus, type StatusResult, type CapacityInfo } from "./app/status.js";
export {
  recordFeedbackEvent,
  getFeedbackScore,
  getFeedbackSummary,
  recordPassiveFeedback,
  type FeedbackEventInput,
  type FeedbackEventRecord,
  type FeedbackSummary,
  type FeedbackSource,
} from "./app/feedback.js";
export {
  reindexMemories,
  type ReindexInput,
  type ReindexProgressEvent,
} from "./app/reindex.js";
export { createHttpServer, startHttpServer, type HttpJobStatus, type HttpServerOptions, type AgentMemoryHttpServer } from "./transports/http.js";

// Core
export { openDatabase, isCountRow, type DbOptions } from "./core/db.js";
export {
  createMemory, getMemory, updateMemory, deleteMemory, listMemories,
  recordAccess, countMemories, contentHash,
  archiveMemory, restoreMemory, listArchivedMemories, purgeArchive,
  type Memory, type MemoryType, type Priority, type CreateMemoryInput, type UpdateMemoryInput,
  type ArchivedMemory,
} from "./core/memory.js";
export {
  createPath, getPath, getPathByUri, getPathsByMemory, getPathsByDomain, getPathsByPrefix,
  deletePath, parseUri, type Path,
} from "./core/path.js";
export { guard, type GuardResult, type GuardAction, type GuardInput, type DedupScoreBreakdown, type ConflictInfo, type ConflictType } from "./core/guard.js";
export { buildMergePlan, type MergePlan, type MergeContext } from "./core/merge.js";
export { exportMemories, type ExportResult } from "./core/export.js";

// Search
export { searchBM25, buildFtsQuery, rebuildBm25Index, type SearchResult } from "./search/bm25.js";
export {
  recallMemories,
  reindexEmbeddings,
  reindexMemorySearch,
  fuseHybridResults,
  fusionScore,
  priorityPrior,
  fetchRelatedLinks,
  type HybridRecallResult,
  type HybridRecallResponse,
  type ReindexEmbeddingsResult,
  type ReindexSearchResult,
  type RelatedLink,
} from "./search/hybrid.js";
export {
  createOpenAICompatibleEmbeddingProvider,
  createLocalHttpEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderOptions,
} from "./search/embedding.js";
export {
  createEmbeddingProvider,
  getEmbeddingProvider,
  getEmbeddingProviderFromEnv,
  getEmbeddingProviderConfigFromEnv,
  getConfiguredEmbeddingProviderId,
  healthcheckEmbeddingProvider,
  type EmbeddingProviderConfig,
  type EmbeddingProviderKind,
} from "./search/providers.js";
export {
  encodeVector,
  decodeVector,
  cosineSimilarity,
  getEmbedding,
  markMemoryEmbeddingPending,
  markAllEmbeddingsPending,
  upsertReadyEmbedding,
  markEmbeddingFailed,
  listPendingEmbeddings,
  searchByVector,
  type EmbeddingStatus,
  type StoredEmbedding,
  type VectorSearchResult,
  type PendingEmbeddingRecord,
} from "./search/vector.js";
export { tokenize } from "./search/tokenizer.js";

// Ingest
export {
  ingestText,
  splitIngestBlocks,
  classifyIngestType,
  extractIngestItems,
  slugify,
  type IngestResult,
  type IngestRunOptions,
  type IngestExtractedItem,
} from "./ingest/ingest.js";
export { runAutoIngestWatcher, type AutoIngestWatcherOptions, type AutoIngestWatcher } from "./ingest/watcher.js";

// Sleep
export { calculateVitality, runDecay, getDecayedMemories } from "./sleep/decay.js";
export { syncOne, syncBatch, type SyncInput, type SyncResult } from "./sleep/sync.js";
export { runTidy, isStaleContent, type TidyResult } from "./sleep/tidy.js";
export { runGovern, rankEvictionCandidates, computeEvictionScore, getTieredCapacity, type GovernResult, type EvictionCandidate, type TieredCapacity } from "./sleep/govern.js";
export {
  boot,
  formatRelativeDate,
  loadWarmBootLayers,
  formatNarrativeBoot,
  type BootResult,
  type WarmBootOptions,
  type WarmBootResult,
} from "./sleep/boot.js";
export {
  createMaintenanceJob,
  getMaintenanceJob,
  findResumableMaintenanceJob,
  updateMaintenanceCheckpoint,
  failMaintenanceJob,
  completeMaintenanceJob,
  createInitialCheckpoint,
  type MaintenanceJob,
  type MaintenancePhase,
  type MaintenanceStatus,
  type ReflectCheckpoint,
  type ReflectStep,
} from "./sleep/jobs.js";
export {
  runReflectOrchestrator,
  type ReflectOptions,
  type ReflectProgressEvent,
  type ReflectRunResult,
  type ReflectRunners,
  type ReflectStats,
} from "./sleep/orchestrator.js";
