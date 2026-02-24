// AgentMemory v3 — Main library entry point

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
export { guard, type GuardResult, type GuardAction } from "./core/guard.js";
export { exportMemories, type ExportResult } from "./core/export.js";

// Search
export { searchBM25, type SearchResult } from "./search/bm25.js";
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
export { runTidy, type TidyResult } from "./sleep/tidy.js";
export { runGovern, type GovernResult } from "./sleep/govern.js";
export { boot, type BootResult } from "./sleep/boot.js";
