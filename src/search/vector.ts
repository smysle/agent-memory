import type Database from "better-sqlite3";
import { newId, now } from "../core/db.js";
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

export function getEmbedding(db: Database.Database, memoryId: string, providerId: string): StoredEmbedding | null {
  return (db.prepare("SELECT * FROM embeddings WHERE memory_id = ? AND provider_id = ?").get(memoryId, providerId) as StoredEmbedding) ?? null;
}

export function markMemoryEmbeddingPending(
  db: Database.Database,
  memoryId: string,
  providerId: string,
  contentHash: string,
): void {
  db.prepare(
    `INSERT INTO embeddings (id, memory_id, provider_id, vector, content_hash, status, created_at)
     VALUES (?, ?, ?, NULL, ?, 'pending', ?)
     ON CONFLICT(memory_id, provider_id) DO UPDATE SET
       vector = NULL,
       content_hash = excluded.content_hash,
       status = 'pending'`,
  ).run(newId(), memoryId, providerId, contentHash, now());
}

export function markAllEmbeddingsPending(db: Database.Database, memoryId: string, contentHash: string): number {
  const result = db.prepare(
    `UPDATE embeddings
     SET vector = NULL,
         content_hash = ?,
         status = 'pending'
     WHERE memory_id = ?`,
  ).run(contentHash, memoryId);
  return result.changes;
}

export function upsertReadyEmbedding(input: {
  db: Database.Database;
  memoryId: string;
  providerId: string;
  vector: ArrayLike<number>;
  contentHash: string;
}): void {
  input.db.prepare(
    `INSERT INTO embeddings (id, memory_id, provider_id, vector, content_hash, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'ready', ?)
     ON CONFLICT(memory_id, provider_id) DO UPDATE SET
       vector = excluded.vector,
       content_hash = excluded.content_hash,
       status = 'ready'`,
  ).run(newId(), input.memoryId, input.providerId, encodeVector(input.vector), input.contentHash, now());
}

export function markEmbeddingFailed(
  db: Database.Database,
  memoryId: string,
  providerId: string,
  contentHash: string,
): void {
  db.prepare(
    `INSERT INTO embeddings (id, memory_id, provider_id, vector, content_hash, status, created_at)
     VALUES (?, ?, ?, NULL, ?, 'failed', ?)
     ON CONFLICT(memory_id, provider_id) DO UPDATE SET
       vector = NULL,
       content_hash = excluded.content_hash,
       status = 'failed'`,
  ).run(newId(), memoryId, providerId, contentHash, now());
}

export function listPendingEmbeddings(
  db: Database.Database,
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

  return db.prepare(
    `SELECT e.id as embeddingId,
            e.memory_id as memoryId,
            m.content as content,
            e.content_hash as contentHash,
            e.provider_id as providerId,
            e.status as status
     FROM embeddings e
     JOIN memories m ON m.id = e.memory_id
     WHERE e.provider_id = ?
       AND m.agent_id = ?
       AND e.status IN (${placeholders})
     ORDER BY e.created_at ASC
     LIMIT ?`,
  ).all(opts.providerId, agentId, ...statuses, limit) as PendingEmbeddingRecord[];
}

export function searchByVector(
  db: Database.Database,
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
  const agentId = opts.agent_id ?? "default";
  const minVitality = opts.min_vitality ?? 0;

  const conditions = [
    "e.provider_id = ?",
    "e.status = 'ready'",
    "e.vector IS NOT NULL",
    "e.content_hash = m.hash",
    "m.agent_id = ?",
    "m.vitality >= ?",
  ];
  const params: unknown[] = [opts.providerId, agentId, minVitality];

  if (opts.after) {
    conditions.push("m.updated_at >= ?");
    params.push(opts.after);
  }
  if (opts.before) {
    conditions.push("m.updated_at <= ?");
    params.push(opts.before);
  }

  const rows = db.prepare(
    `SELECT e.provider_id, e.vector, e.content_hash,
            m.id, m.content, m.type, m.priority, m.emotion_val, m.vitality,
            m.stability, m.access_count, m.last_accessed, m.created_at,
            m.updated_at, m.source, m.agent_id, m.hash
     FROM embeddings e
     JOIN memories m ON m.id = e.memory_id
     WHERE ${conditions.join(" AND ")}`,
  ).all(...params) as Array<{ provider_id: string; vector: Buffer; content_hash: string } & Memory>;

  const scored = rows
    .map((row) => ({
      provider_id: row.provider_id,
      memory: {
        id: row.id,
        content: row.content,
        type: row.type,
        priority: row.priority,
        emotion_val: row.emotion_val,
        vitality: row.vitality,
        stability: row.stability,
        access_count: row.access_count,
        last_accessed: row.last_accessed,
        created_at: row.created_at,
        updated_at: row.updated_at,
        source: row.source,
        agent_id: row.agent_id,
        hash: row.hash,
      } as Memory,
      similarity: cosineSimilarity(queryVector, decodeVector(row.vector)),
    }))
    .filter((row) => Number.isFinite(row.similarity) && row.similarity > 0)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit);

  return scored.map((row, index) => ({
    memory: row.memory,
    similarity: row.similarity,
    rank: index + 1,
    provider_id: row.provider_id,
  }));
}
