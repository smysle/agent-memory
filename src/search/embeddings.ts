// AgentMemory v2 — Embedding storage helpers (SQLite BLOB)
import type Database from "better-sqlite3";
import { now } from "../core/db.js";

export interface StoredEmbedding {
  agent_id: string;
  memory_id: string;
  model: string;
  dim: number;
  vector: Float32Array;
  created_at: string;
  updated_at: string;
}

export function encodeEmbedding(vector: number[] | Float32Array): Buffer {
  const arr = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  // Node Buffer shares memory with underlying ArrayBuffer view.
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function decodeEmbedding(buf: Buffer): Float32Array {
  // Copy to detach from sqlite/Buffer lifetime assumptions.
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

export function upsertEmbedding(
  db: Database.Database,
  input: {
    agent_id: string;
    memory_id: string;
    model: string;
    vector: number[] | Float32Array;
  },
): void {
  const ts = now();
  const vec = input.vector instanceof Float32Array ? input.vector : Float32Array.from(input.vector);
  const blob = encodeEmbedding(vec);
  db.prepare(
    `INSERT INTO embeddings (agent_id, memory_id, model, dim, vector, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, memory_id, model) DO UPDATE SET
       dim = excluded.dim,
       vector = excluded.vector,
       updated_at = excluded.updated_at`,
  ).run(input.agent_id, input.memory_id, input.model, vec.length, blob, ts, ts);
}

export function getEmbedding(
  db: Database.Database,
  agent_id: string,
  memory_id: string,
  model: string,
): StoredEmbedding | null {
  const row = db.prepare(
    "SELECT agent_id, memory_id, model, dim, vector, created_at, updated_at FROM embeddings WHERE agent_id = ? AND memory_id = ? AND model = ?",
  ).get(agent_id, memory_id, model) as (Omit<StoredEmbedding, "vector"> & { vector: Buffer }) | undefined;
  if (!row) return null;
  return { ...row, vector: decodeEmbedding(row.vector) };
}

export function listEmbeddings(
  db: Database.Database,
  agent_id: string,
  model: string,
): Array<{ memory_id: string; vector: Float32Array }> {
  const rows = db.prepare(
    "SELECT memory_id, vector FROM embeddings WHERE agent_id = ? AND model = ?",
  ).all(agent_id, model) as Array<{ memory_id: string; vector: Buffer }>;
  return rows.map((r) => ({ memory_id: r.memory_id, vector: decodeEmbedding(r.vector) }));
}

