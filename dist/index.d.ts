export { D as DbOptions, o as openDatabase } from './db-CMsKtBt0.js';
import Database from 'better-sqlite3';

type MemoryType = "identity" | "emotion" | "knowledge" | "event";
type Priority = 0 | 1 | 2 | 3;
interface Memory {
    id: string;
    content: string;
    type: MemoryType;
    priority: Priority;
    emotion_val: number;
    vitality: number;
    stability: number;
    access_count: number;
    last_accessed: string | null;
    created_at: string;
    updated_at: string;
    source: string | null;
    agent_id: string;
    hash: string | null;
}
interface CreateMemoryInput {
    content: string;
    type: MemoryType;
    priority?: Priority;
    emotion_val?: number;
    source?: string;
    agent_id?: string;
}
interface UpdateMemoryInput {
    content?: string;
    type?: MemoryType;
    priority?: Priority;
    emotion_val?: number;
    vitality?: number;
    stability?: number;
    source?: string;
}
declare function contentHash(content: string): string;
declare function createMemory(db: Database.Database, input: CreateMemoryInput): Memory | null;
declare function getMemory(db: Database.Database, id: string): Memory | null;
declare function updateMemory(db: Database.Database, id: string, input: UpdateMemoryInput): Memory | null;
declare function deleteMemory(db: Database.Database, id: string): boolean;
declare function listMemories(db: Database.Database, opts?: {
    agent_id?: string;
    type?: MemoryType;
    priority?: Priority;
    min_vitality?: number;
    limit?: number;
    offset?: number;
}): Memory[];
declare function recordAccess(db: Database.Database, id: string, growthFactor?: number): void;
declare function countMemories(db: Database.Database, agent_id?: string): {
    total: number;
    by_type: Record<string, number>;
    by_priority: Record<string, number>;
};

interface Path {
    id: string;
    memory_id: string;
    uri: string;
    alias: string | null;
    domain: string;
    created_at: string;
}
declare function parseUri(uri: string): {
    domain: string;
    path: string;
};
declare function createPath(db: Database.Database, memoryId: string, uri: string, alias?: string, validDomains?: Set<string>): Path;
declare function getPath(db: Database.Database, id: string): Path | null;
declare function getPathByUri(db: Database.Database, uri: string): Path | null;
declare function getPathsByMemory(db: Database.Database, memoryId: string): Path[];
declare function getPathsByDomain(db: Database.Database, domain: string): Path[];
declare function getPathsByPrefix(db: Database.Database, prefix: string): Path[];
declare function deletePath(db: Database.Database, id: string): boolean;

type RelationType = "related" | "caused" | "reminds" | "evolved" | "contradicts";
interface Link {
    source_id: string;
    target_id: string;
    relation: RelationType;
    weight: number;
    created_at: string;
}
declare function createLink(db: Database.Database, sourceId: string, targetId: string, relation: RelationType, weight?: number): Link;
declare function getLinks(db: Database.Database, memoryId: string): Link[];
declare function getOutgoingLinks(db: Database.Database, sourceId: string): Link[];
/**
 * Multi-hop traversal: find all memories reachable within N hops
 * Inspired by PowerMem's knowledge graph traversal
 */
declare function traverse(db: Database.Database, startId: string, maxHops?: number): Array<{
    id: string;
    hop: number;
    relation: string;
}>;
declare function deleteLink(db: Database.Database, sourceId: string, targetId: string): boolean;

type SnapshotAction = "create" | "update" | "delete" | "merge";
interface Snapshot {
    id: string;
    memory_id: string;
    content: string;
    changed_by: string | null;
    action: SnapshotAction;
    created_at: string;
}
/**
 * Create a snapshot before modifying a memory.
 * Call this BEFORE any update/delete operation.
 */
declare function createSnapshot(db: Database.Database, memoryId: string, action: SnapshotAction, changedBy?: string): Snapshot;
declare function getSnapshots(db: Database.Database, memoryId: string): Snapshot[];
declare function getSnapshot(db: Database.Database, id: string): Snapshot | null;
/**
 * Rollback a memory to a specific snapshot.
 * Creates a new snapshot of the current state before rolling back.
 */
declare function rollback(db: Database.Database, snapshotId: string): boolean;

type GuardAction = "add" | "update" | "skip" | "merge";
interface GuardResult {
    action: GuardAction;
    reason: string;
    existingId?: string;
    mergedContent?: string;
}
/**
 * Write Guard — decides whether to add, update, skip, or merge a memory.
 *
 * Pipeline:
 * 1. Hash dedup (exact content match → skip)
 * 2. URI conflict (URI exists → update path)
 * 3. BM25 similarity (>0.85 → conflict detection → merge or update)
 * 4. Four-criterion gate (for P0/P1 only)
 */
declare function guard(db: Database.Database, input: CreateMemoryInput & {
    uri?: string;
}): GuardResult;

interface SearchResult {
    memory: Memory;
    score: number;
    matchReason: string;
}
/**
 * BM25 search using SQLite FTS5.
 * Returns memories ranked by relevance.
 */
declare function searchBM25(db: Database.Database, query: string, opts?: {
    agent_id?: string;
    limit?: number;
    min_vitality?: number;
}): SearchResult[];

/**
 * Tokenize text for FTS5 queries.
 * - Latin/numeric words: split on whitespace, filter len > 1
 * - CJK text: use jieba cutForSearch, fallback to unigram + bigram
 * Returns deduplicated token array, max 30 tokens.
 */
declare function tokenize(text: string): string[];

type SearchIntent = "factual" | "exploratory" | "temporal" | "causal";
interface IntentResult {
    intent: SearchIntent;
    confidence: number;
}
/**
 * Classify the intent of a search query.
 * Uses keyword scoring — no LLM needed.
 */
declare function classifyIntent(query: string): IntentResult;
/**
 * Get search strategy based on intent
 */
declare function getStrategy(intent: SearchIntent): {
    boostRecent: boolean;
    boostPriority: boolean;
    limit: number;
};

/**
 * Rerank search results based on intent strategy and priority weighting.
 */
declare function rerank(results: SearchResult[], opts: {
    intent?: SearchIntent;
    boostRecent: boolean;
    boostPriority: boolean;
    limit: number;
}): SearchResult[];

declare function calculateVitality(stability: number, daysSinceCreation: number, priority: number): number;
/**
 * Run decay on all memories.
 * Updates vitality based on Ebbinghaus curve.
 * Returns count of memories updated.
 */
declare function runDecay(db: Database.Database): {
    updated: number;
    decayed: number;
    belowThreshold: number;
};
/**
 * Get memories that are candidates for cleanup (vitality < threshold).
 * Only P3 (event) memories can be fully cleaned.
 */
declare function getDecayedMemories(db: Database.Database, threshold?: number): Array<{
    id: string;
    content: string;
    vitality: number;
    priority: number;
}>;

interface SyncInput {
    content: string;
    type?: CreateMemoryInput["type"];
    priority?: CreateMemoryInput["priority"];
    emotion_val?: number;
    uri?: string;
    source?: string;
    agent_id?: string;
}
interface SyncResult {
    action: "added" | "updated" | "merged" | "skipped";
    memoryId?: string;
    reason: string;
}
/**
 * Sync a single piece of information into memory.
 * Runs full Write Guard pipeline before writing.
 */
declare function syncOne(db: Database.Database, input: SyncInput): SyncResult;
/**
 * Sync multiple items in a batch (within a transaction).
 */
declare function syncBatch(db: Database.Database, inputs: SyncInput[]): SyncResult[];

interface TidyResult {
    archived: number;
    orphansCleaned: number;
    snapshotsPruned: number;
}
/**
 * Run the tidy (deep sleep) cycle:
 * 1. Archive decayed P3 memories (vitality < threshold)
 * 2. Clean orphan paths (paths with no memory)
 * 3. Prune old snapshots (keep last N per memory)
 */
declare function runTidy(db: Database.Database, opts?: {
    vitalityThreshold?: number;
    maxSnapshotsPerMemory?: number;
}): TidyResult;

interface GovernResult {
    orphanPaths: number;
    orphanLinks: number;
    emptyMemories: number;
}
/**
 * Run governance checks and cleanup:
 * 1. Remove orphan paths (no parent memory)
 * 2. Remove orphan links (source or target missing)
 * 3. Remove empty memories (blank content)
 */
declare function runGovern(db: Database.Database): GovernResult;

interface BootResult {
    identityMemories: Memory[];
    bootPaths: string[];
}
/**
 * Load core identity memories at startup.
 * Returns all P0 (identity) memories + any memories referenced by system://boot.
 */
declare function boot(db: Database.Database, opts?: {
    agent_id?: string;
    corePaths?: string[];
}): BootResult;

export { type BootResult, type CreateMemoryInput, type GovernResult, type GuardAction, type GuardResult, type IntentResult, type Link, type Memory, type MemoryType, type Path, type Priority, type RelationType, type SearchIntent, type SearchResult, type Snapshot, type SnapshotAction, type SyncInput, type SyncResult, type TidyResult, type UpdateMemoryInput, boot, calculateVitality, classifyIntent, contentHash, countMemories, createLink, createMemory, createPath, createSnapshot, deleteLink, deleteMemory, deletePath, getDecayedMemories, getLinks, getMemory, getOutgoingLinks, getPath, getPathByUri, getPathsByDomain, getPathsByMemory, getPathsByPrefix, getSnapshot, getSnapshots, getStrategy, guard, listMemories, parseUri, recordAccess, rerank, rollback, runDecay, runGovern, runTidy, searchBM25, syncBatch, syncOne, tokenize, traverse, updateMemory };
