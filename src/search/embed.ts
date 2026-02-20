// AgentMemory v2 — Embedding generation helpers (async)
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "./providers.js";
import { upsertEmbedding } from "./embeddings.js";

export async function embedMemory(
  db: Database.Database,
  memoryId: string,
  provider: EmbeddingProvider,
  opts?: { agent_id?: string; model?: string; maxChars?: number },
): Promise<boolean> {
  const row = db.prepare("SELECT id, agent_id, content FROM memories WHERE id = ?").get(memoryId) as { id: string; agent_id: string; content: string } | undefined;
  if (!row) return false;
  if (opts?.agent_id && row.agent_id !== opts.agent_id) return false;

  const model = opts?.model ?? provider.model;
  const maxChars = opts?.maxChars ?? 2000;
  const text = row.content.length > maxChars ? row.content.slice(0, maxChars) : row.content;

  const vector = await provider.embed(text);
  upsertEmbedding(db, {
    agent_id: row.agent_id,
    memory_id: row.id,
    model,
    vector,
  });
  return true;
}

export async function embedMissingForAgent(
  db: Database.Database,
  provider: EmbeddingProvider,
  opts?: { agent_id?: string; model?: string; limit?: number; maxChars?: number },
): Promise<{ embedded: number; scanned: number }> {
  const agentId = opts?.agent_id ?? "default";
  const model = opts?.model ?? provider.model;
  const limit = opts?.limit ?? 1000;

  const rows = db.prepare(
    `SELECT m.id
     FROM memories m
     LEFT JOIN embeddings e
       ON e.memory_id = m.id AND e.agent_id = m.agent_id AND e.model = ?
     WHERE m.agent_id = ? AND e.memory_id IS NULL
     ORDER BY m.updated_at DESC
     LIMIT ?`,
  ).all(model, agentId, limit) as Array<{ id: string }>;

  let embedded = 0;
  for (const r of rows) {
    const ok = await embedMemory(db, r.id, provider, { agent_id: agentId, model, maxChars: opts?.maxChars });
    if (ok) embedded++;
  }
  return { embedded, scanned: rows.length };
}

