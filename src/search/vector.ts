import Database from "better-sqlite3";
import { createHash } from "crypto";
import { mkdirSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import type MainDatabase from "better-sqlite3";
import { getDatabasePath, newId, now } from "../core/db.js";
import type { Memory } from "../core/memory.js";

export type EmbeddingStatus = "pending" | "ready" | "failed";

export interface StoredEmbedding {
  id: string;
  memory_id: string;
  provider_id: string;
  vector: Buffer | null;
  content_hash: string;
  status: EmbeddingStatus;
  created_at: string;
  updated_at?: string;
}

export interface VectorSearchResult {
  memory: Memory;
  similarity: number;
  rank: number;
  provider_id: string;
}

export interface PendingEmbeddingRecord {
  embeddingId: string;
  memoryId: string;
  content: string;
  contentHash: string;
  providerId: string;
  status: EmbeddingStatus;
}

interface SidecarEmbeddingRow {
  id: string;
  memory_id: string;
  provider_id: string;
  vector: Buffer | null;
  content_hash: string;
  status: EmbeddingStatus;
  created_at: string;
  updated_at: string;
}

interface SidecarSearchRow {
  memory_id: string;
  provider_id: string;
  vector: Buffer;
  content_hash: string;
}

const SIDECAR_DB_CACHE = new Map<string, Database.Database>();

const SIDECAR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS embeddings (
  id           TEXT PRIMARY KEY,
  memory_id    TEXT NOT NULL,
  provider_id  TEXT NOT NULL,
  vector       BLOB,
  content_hash TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(memory_id, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_provider_status
ON embeddings(provider_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_embeddings_memory_provider
ON embeddings(memory_id, provider_id);
`;

export function encodeVector(vector: ArrayLike<number>): Buffer {
  const float32 = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return Buffer.from(float32.buffer.slice(float32.byteOffset, float32.byteOffset + float32.byteLength));
}

export function decodeVector(blob: Uint8Array | ArrayBuffer): number[] {
  const buffer = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const aligned = buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
    ? buffer.buffer
    : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return Array.from(new Float32Array(aligned));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  if (length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < length; index++) {
    const left = Number(a[index] ?? 0);
    const right = Number(b[index] ?? 0);
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sanitizeProviderId(providerId: string): string {
  return providerId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "default";
}

function buildSidecarKey(mainDbPath: string, providerId: string): string {
  return `${mainDbPath}::${providerId}`;
}

function sidecarDbPathFor(mainDbPath: string, providerId: string): string {
  const baseDir = dirname(resolve(mainDbPath));
  const sidecarDir = join(baseDir, ".agent-memory-vectors");
  const suffix = createHash("sha1").update(providerId).digest("hex").slice(0, 8);
  return join(sidecarDir, `${sanitizeProviderId(providerId)}-${suffix}.db`);
}

function getSidecarDbPath(db: MainDatabase.Database, providerId: string): string {
  const mainDbPath = getDatabasePath(db);
  if (!mainDbPath) {
    throw new Error("Unable to resolve main database path for vector sidecar storage");
  }
  return sidecarDbPathFor(mainDbPath, providerId);
}

function openVectorSidecar(db: MainDatabase.Database, providerId: string): Database.Database {
  const mainDbPath = getDatabasePath(db);
  if (!mainDbPath) {
    throw new Error("Unable to resolve main database path for vector sidecar storage");
  }

  const cacheKey = buildSidecarKey(mainDbPath, providerId);
  const cached = SIDECAR_DB_CACHE.get(cacheKey);
  if (cached) return cached;

  const sidecarPath = sidecarDbPathFor(mainDbPath, providerId);
  mkdirSync(dirname(sidecarPath), { recursive: true });

  const sidecar = new Database(sidecarPath);
  sidecar.pragma("journal_mode = WAL");
  sidecar.pragma("foreign_keys = ON");
  sidecar.pragma("busy_timeout = 5000");
  sidecar.exec(SIDECAR_SCHEMA_SQL);

  SIDECAR_DB_CACHE.set(cacheKey, sidecar);
  return sidecar;
}

function getMemoryMap(
  db: MainDatabase.Database,
  ids: string[],
  opts: { agent_id?: string; min_vitality?: number; after?: string; before?: string },
): Map<string, Memory> {
  if (ids.length === 0) return new Map();

  const agentId = opts.agent_id ?? "default";
  const minVitality = opts.min_vitality ?? 0;
  const conditions = [
    `id IN (${ids.map(() => "?").join(", ")})`,
    "agent_id = ?",
    "vitality >= ?",
  ];
  const params: unknown[] = [...ids, agentId, minVitality];

  if (opts.after) {
    conditions.push("updated_at >= ?");
    params.push(opts.after);
  }
  if (opts.before) {
    conditions.push("updated_at <= ?");
    params.push(opts.before);
  }

  const rows = db.prepare(
    `SELECT * FROM memories WHERE ${conditions.join(" AND ")}`,
  ).all(...params) as Memory[];

  return new Map(rows.map((row) => [row.id, row]));
}

function getMemoryContentMap(
  db: MainDatabase.Database,
  ids: string[],
  agentId: string,
): Map<string, string> {
  if (ids.length === 0) return new Map();

  const rows = db.prepare(
    `SELECT id, content
     FROM memories
     WHERE id IN (${ids.map(() => "?").join(", ")})
       AND agent_id = ?`,
  ).all(...ids, agentId) as Array<{ id: string; content: string }>;

  return new Map(rows.map((row) => [row.id, row.content]));
}

function getLegacyEmbedding(db: MainDatabase.Database, memoryId: string, providerId: string): StoredEmbedding | null {
  try {
    return (db.prepare("SELECT * FROM embeddings WHERE memory_id = ? AND provider_id = ?").get(memoryId, providerId) as StoredEmbedding) ?? null;
  } catch {
    return null;
  }
}

function legacyMarkMemoryEmbeddingPending(
  db: MainDatabase.Database,
  memoryId: string,
  providerId: string,
  contentHash: string,
): void {
  try {
    db.prepare(
      `INSERT INTO embeddings (id, memory_id, provider_id, vector, content_hash, status, created_at)
       VALUES (?, ?, ?, NULL, ?, 'pending', ?)
       ON CONFLICT(memory_id, provider_id) DO UPDATE SET
         vector = NULL,
         content_hash = excluded.content_hash,
         status = 'pending'`,
    ).run(newId(), memoryId, providerId, contentHash, now());
  } catch {
    // Ignore legacy mirror failures.
  }
}

function legacyMarkAllEmbeddingsPending(db: MainDatabase.Database, memoryId: string, contentHash: string): number {
  try {
    const result = db.prepare(
      `UPDATE embeddings
       SET vector = NULL,
           content_hash = ?,
           status = 'pending'
       WHERE memory_id = ?`,
    ).run(contentHash, memoryId);
    return result.changes;
  } catch {
    return 0;
  }
}

function legacyUpsertReadyEmbedding(
  db: MainDatabase.Database,
  memoryId: string,
  providerId: string,
  vector: ArrayLike<number>,
  contentHash: string,
): void {
  try {
    db.prepare(
      `INSERT INTO embeddings (id, memory_id, provider_id, vector, content_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'ready', ?)
       ON CONFLICT(memory_id, provider_id) DO UPDATE SET
         vector = excluded.vector,
         content_hash = excluded.content_hash,
         status = 'ready'`,
    ).run(newId(), memoryId, providerId, encodeVector(vector), contentHash, now());
  } catch {
    // Ignore legacy mirror failures.
  }
}

function legacyMarkEmbeddingFailed(
  db: MainDatabase.Database,
  memoryId: string,
  providerId: string,
  contentHash: string,
): void {
  try {
    db.prepare(
      `INSERT INTO embeddings (id, memory_id, provider_id, vector, content_hash, status, created_at)
       VALUES (?, ?, ?, NULL, ?, 'failed', ?)
       ON CONFLICT(memory_id, provider_id) DO UPDATE SET
         vector = NULL,
         content_hash = excluded.content_hash,
         status = 'failed'`,
    ).run(newId(), memoryId, providerId, contentHash, now());
  } catch {
    // Ignore legacy mirror failures.
  }
}

export function getEmbedding(db: MainDatabase.Database, memoryId: string, providerId: string): StoredEmbedding | null {
  const sidecar = openVectorSidecar(db, providerId);
  const row = sidecar.prepare(
    "SELECT id, memory_id, provider_id, vector, content_hash, status, created_at, updated_at FROM embeddings WHERE memory_id = ? AND provider_id = ?",
  ).get(memoryId, providerId) as SidecarEmbeddingRow | undefined;

  if (row) {
    return row;
  }

  return getLegacyEmbedding(db, memoryId, providerId);
}

export function markMemoryEmbeddingPending(
  db: MainDatabase.Database,
  memoryId: string,
  providerId: string,
  contentHash: string,
): void {
  const sidecar = openVectorSidecar(db, providerId);
  sidecar.prepare(
    `INSERT INTO embeddings (id, memory_id, provider_id, vector, content_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 'pending', ?, ?)
     ON CONFLICT(memory_id, provider_id) DO UPDATE SET
       vector = NULL,
       content_hash = excluded.content_hash,
       status = 'pending',
       updated_at = excluded.updated_at`,
  ).run(newId(), memoryId, providerId, contentHash, now(), now());

  legacyMarkMemoryEmbeddingPending(db, memoryId, providerId, contentHash);
}

export function markAllEmbeddingsPending(db: MainDatabase.Database, memoryId: string, contentHash: string): number {
  const mainDbPath = getDatabasePath(db);
  let changes = 0;

  if (mainDbPath) {
    for (const [cacheKey, sidecar] of SIDECAR_DB_CACHE.entries()) {
      if (!cacheKey.startsWith(`${mainDbPath}::`)) continue;
      const result = sidecar.prepare(
        `UPDATE embeddings
         SET vector = NULL,
             content_hash = ?,
             status = 'pending',
             updated_at = ?
         WHERE memory_id = ?`,
      ).run(contentHash, now(), memoryId);
      changes += result.changes;
    }
  }

  changes += legacyMarkAllEmbeddingsPending(db, memoryId, contentHash);
  return changes;
}

export function upsertReadyEmbedding(input: {
  db: MainDatabase.Database;
  memoryId: string;
  providerId: string;
  vector: ArrayLike<number>;
  contentHash: string;
}): void {
  const sidecar = openVectorSidecar(input.db, input.providerId);
  sidecar.prepare(
    `INSERT INTO embeddings (id, memory_id, provider_id, vector, content_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)
     ON CONFLICT(memory_id, provider_id) DO UPDATE SET
       vector = excluded.vector,
       content_hash = excluded.content_hash,
       status = 'ready',
       updated_at = excluded.updated_at`,
  ).run(newId(), input.memoryId, input.providerId, encodeVector(input.vector), input.contentHash, now(), now());

  legacyUpsertReadyEmbedding(input.db, input.memoryId, input.providerId, input.vector, input.contentHash);
}

export function markEmbeddingFailed(
  db: MainDatabase.Database,
  memoryId: string,
  providerId: string,
  contentHash: string,
): void {
  const sidecar = openVectorSidecar(db, providerId);
  sidecar.prepare(
    `INSERT INTO embeddings (id, memory_id, provider_id, vector, content_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 'failed', ?, ?)
     ON CONFLICT(memory_id, provider_id) DO UPDATE SET
       vector = NULL,
       content_hash = excluded.content_hash,
       status = 'failed',
       updated_at = excluded.updated_at`,
  ).run(newId(), memoryId, providerId, contentHash, now(), now());

  legacyMarkEmbeddingFailed(db, memoryId, providerId, contentHash);
}

export function listPendingEmbeddings(
  db: MainDatabase.Database,
  opts: {
    providerId: string;
    agent_id?: string;
    limit?: number;
    includeFailed?: boolean;
  },
): PendingEmbeddingRecord[] {
  const statuses = opts.includeFailed ? ["pending", "failed"] : ["pending"];
  const placeholders = statuses.map(() => "?").join(", ");
  const limit = opts.limit ?? 100;
  const agentId = opts.agent_id ?? "default";
  const sidecar = openVectorSidecar(db, opts.providerId);

  const rows = sidecar.prepare(
    `SELECT id as embeddingId,
            memory_id as memoryId,
            content_hash as contentHash,
            provider_id as providerId,
            status as status
     FROM embeddings
     WHERE provider_id = ?
       AND status IN (${placeholders})
     ORDER BY updated_at ASC
     LIMIT ?`,
  ).all(opts.providerId, ...statuses, limit) as Array<Omit<PendingEmbeddingRecord, "content">>;

  const contentMap = getMemoryContentMap(db, rows.map((row) => row.memoryId), agentId);
  return rows
    .map((row) => ({
      ...row,
      content: contentMap.get(row.memoryId),
    }))
    .filter((row): row is PendingEmbeddingRecord => typeof row.content === "string");
}

export function searchByVector(
  db: MainDatabase.Database,
  queryVector: ArrayLike<number>,
  opts: {
    providerId: string;
    agent_id?: string;
    limit?: number;
    min_vitality?: number;
    after?: string;
    before?: string;
  },
): VectorSearchResult[] {
  const limit = opts.limit ?? 20;
  const sidecar = openVectorSidecar(db, opts.providerId);

  const rows = sidecar.prepare(
    `SELECT memory_id, provider_id, vector, content_hash
     FROM embeddings
     WHERE provider_id = ?
       AND status = 'ready'
       AND vector IS NOT NULL`,
  ).all(opts.providerId) as SidecarSearchRow[];

  const ids = rows.map((row) => row.memory_id);
  const memoryMap = getMemoryMap(db, ids, {
    agent_id: opts.agent_id,
    min_vitality: opts.min_vitality,
    after: opts.after,
    before: opts.before,
  });

  const scored = rows
    .map((row) => {
      const memory = memoryMap.get(row.memory_id);
      if (!memory || memory.hash !== row.content_hash) return null;
      return {
        provider_id: row.provider_id,
        memory,
        similarity: cosineSimilarity(queryVector, decodeVector(row.vector)),
      };
    })
    .filter((row): row is { provider_id: string; memory: Memory; similarity: number } =>
      row !== null && Number.isFinite(row.similarity) && row.similarity > 0,
    )
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit);

  return scored.map((row, index) => ({
    memory: row.memory,
    similarity: row.similarity,
    rank: index + 1,
    provider_id: row.provider_id,
  }));
}

export function deleteEmbeddingRecords(db: MainDatabase.Database, memoryId: string): void {
  const mainDbPath = getDatabasePath(db);
  if (mainDbPath) {
    for (const [cacheKey, sidecar] of SIDECAR_DB_CACHE.entries()) {
      if (!cacheKey.startsWith(`${mainDbPath}::`)) continue;
      sidecar.prepare("DELETE FROM embeddings WHERE memory_id = ?").run(memoryId);
    }
  }

  try {
    db.prepare("DELETE FROM embeddings WHERE memory_id = ?").run(memoryId);
  } catch {
    // Ignore legacy mirror failures.
  }
}

export function getVectorSidecarPath(db: MainDatabase.Database, providerId: string): string {
  return getSidecarDbPath(db, providerId);
}

export function resetVectorSidecar(db: MainDatabase.Database, providerId: string): void {
  const mainDbPath = getDatabasePath(db);
  const sidecarPath = getSidecarDbPath(db, providerId);

  if (mainDbPath) {
    const cacheKey = buildSidecarKey(mainDbPath, providerId);
    const cached = SIDECAR_DB_CACHE.get(cacheKey);
    if (cached) {
      cached.close();
      SIDECAR_DB_CACHE.delete(cacheKey);
    }
  }

  try { rmSync(sidecarPath); } catch {}
  try { rmSync(`${sidecarPath}-wal`); } catch {}
  try { rmSync(`${sidecarPath}-shm`); } catch {}
}
