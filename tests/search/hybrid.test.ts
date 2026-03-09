import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";
import { openDatabase } from "../../src/core/db.js";
import { createMemory, updateMemory } from "../../src/core/memory.js";
import {
  fuseHybridResults,
  recallMemories,
  reindexEmbeddings,
} from "../../src/search/hybrid.js";
import type { EmbeddingProvider } from "../../src/search/embedding.js";
import { searchBM25 } from "../../src/search/bm25.js";
import { searchByVector, upsertReadyEmbedding } from "../../src/search/vector.js";

const TEST_DB = "/tmp/agent-memory-hybrid-test.db";

function createStubProvider(vectors: Record<string, number[]>, id = "provider:stub"): EmbeddingProvider {
  return {
    id,
    model: "stub",
    dimension: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => vectors[text] ?? [0, 0]);
    },
  };
}

describe("hybrid retrieval", () => {
  let db: Database.Database;

  beforeEach(() => {
    [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try { unlinkSync(file); } catch {}
    });
    db = openDatabase({ path: TEST_DB });
  });

  afterEach(() => {
    db.close();
    [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try { unlinkSync(file); } catch {}
    });
  });

  it("falls back to BM25-only when no provider is configured", async () => {
    const lexical = createMemory(db, { content: "蓝紫渐变和玻璃拟态不要用", type: "knowledge" })!;
    createMemory(db, { content: "今天出门买咖啡", type: "event" });

    const result = await recallMemories(db, "玻璃拟态", { limit: 5, provider: null });

    expect(result.mode).toBe("bm25-only");
    expect(result.results[0]?.memory.id).toBe(lexical.id);
    expect(result.results[0]?.vector_rank).toBeUndefined();
  });

  it("supports vector-only recall when lexical branch has no hits", async () => {
    const provider = createStubProvider({
      aesthetic: [1, 0],
    });
    const memory = createMemory(db, { content: "蓝紫渐变和玻璃拟态不要用", type: "knowledge" })!;
    upsertReadyEmbedding({
      db,
      memoryId: memory.id,
      providerId: provider.id,
      vector: [1, 0],
      contentHash: memory.hash!,
    });

    const result = await recallMemories(db, "aesthetic", { limit: 5, provider });

    expect(result.mode).toBe("vector-only");
    expect(result.results[0]?.memory.id).toBe(memory.id);
    expect(result.results[0]?.vector_rank).toBe(1);
  });

  it("fuses lexical and vector branches with WRRF", async () => {
    const lexicalFirst = createMemory(db, { content: "玻璃拟态不要用", type: "knowledge" })!;
    const semanticFirst = createMemory(db, { content: "界面风格要克制低饱和", type: "identity" })!;

    const provider = createStubProvider({
      风格约束: [1, 0],
    });

    upsertReadyEmbedding({
      db,
      memoryId: lexicalFirst.id,
      providerId: provider.id,
      vector: [0.7, 0.7],
      contentHash: lexicalFirst.hash!,
    });
    upsertReadyEmbedding({
      db,
      memoryId: semanticFirst.id,
      providerId: provider.id,
      vector: [1, 0],
      contentHash: semanticFirst.hash!,
    });

    const lexical = searchBM25(db, "风格 玻璃拟态", { limit: 10 });
    const vector = searchByVector(db, [1, 0], { providerId: provider.id, limit: 10 });
    const fused = fuseHybridResults(lexical, vector, 10);

    expect(fused[0]?.memory.id).toBe(semanticFirst.id);

    const result = await recallMemories(db, "风格约束", { limit: 5, provider });
    expect(result.mode).toBe("dual-path");
    expect(result.results[0]?.memory.id).toBe(semanticFirst.id);
    expect(result.results[0]?.bm25_rank).toBeDefined();
    expect(result.results[0]?.vector_rank).toBeDefined();
  });

  it("supports remember -> pending -> reindex -> recall", async () => {
    const provider = createStubProvider({
      preference: [1, 0],
      "updated preference": [0, 1],
      "UI 要克制、低饱和": [1, 0],
      "更新后的 UI 要克制、低饱和": [0, 1],
    });

    const memory = createMemory(db, {
      content: "UI 要克制、低饱和",
      type: "knowledge",
      embedding_provider_id: provider.id,
    })!;

    const pendingBefore = db.prepare("SELECT status FROM embeddings WHERE memory_id = ? AND provider_id = ?").get(memory.id, provider.id) as { status: string } | undefined;
    expect(pendingBefore?.status).toBe("pending");

    const reindexed = await reindexEmbeddings(db, { provider });
    expect(reindexed.embedded).toBe(1);

    let result = await recallMemories(db, "preference", { provider, limit: 5 });
    expect(result.results[0]?.memory.id).toBe(memory.id);

    updateMemory(db, memory.id, {
      content: "更新后的 UI 要克制、低饱和",
    });

    const pendingAfterUpdate = db.prepare("SELECT status FROM embeddings WHERE memory_id = ? AND provider_id = ?").get(memory.id, provider.id) as { status: string } | undefined;
    expect(pendingAfterUpdate?.status).toBe("pending");

    await reindexEmbeddings(db, { provider });
    result = await recallMemories(db, "updated preference", { provider, limit: 5 });
    expect(result.results[0]?.memory.content).toContain("更新后的 UI");
  });
});
