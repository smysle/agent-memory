import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";
import { openDatabase } from "../../src/core/db.js";
import { createMemory, updateMemory } from "../../src/core/memory.js";
import {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  getEmbedding,
  listPendingEmbeddings,
  markMemoryEmbeddingPending,
  searchByVector,
  upsertReadyEmbedding,
} from "../../src/search/vector.js";

const TEST_DB = "/tmp/agent-memory-vector-test.db";

describe("vector storage + search", () => {
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

  it("encodes/decodes vectors and computes cosine similarity precisely", () => {
    const encoded = encodeVector([1, 0.5, -0.25]);
    expect(decodeVector(encoded)).toEqual([1, 0.5, -0.25]);
    expect(cosineSimilarity([1, 0], [0.5, Math.sqrt(3) / 2])).toBeCloseTo(0.5, 6);
  });

  it("stores pending rows, upgrades them to ready, and searches by cosine similarity", () => {
    const primary = createMemory(db, { content: "蓝紫渐变和玻璃拟态不要用", type: "knowledge" })!;
    const secondary = createMemory(db, { content: "低饱和、克制一点的风格", type: "knowledge" })!;

    markMemoryEmbeddingPending(db, primary.id, "provider:test", primary.hash!);
    expect(listPendingEmbeddings(db, { providerId: "provider:test" })).toHaveLength(1);

    upsertReadyEmbedding({
      db,
      memoryId: primary.id,
      providerId: "provider:test",
      vector: [1, 0],
      contentHash: primary.hash!,
    });
    upsertReadyEmbedding({
      db,
      memoryId: secondary.id,
      providerId: "provider:test",
      vector: [0.7, 0.7],
      contentHash: secondary.hash!,
    });

    const stored = getEmbedding(db, primary.id, "provider:test");
    expect(stored?.status).toBe("ready");

    const results = searchByVector(db, [1, 0], {
      providerId: "provider:test",
      limit: 5,
    });

    expect(results).toHaveLength(2);
    expect(results[0].memory.id).toBe(primary.id);
    expect(results[0].similarity).toBeCloseTo(1, 6);
    expect(results[1].memory.id).toBe(secondary.id);
  });

  it("drops stale embeddings from search once memory content changes", () => {
    const memory = createMemory(db, {
      content: "初始风格约束",
      type: "knowledge",
      embedding_provider_id: "provider:test",
    })!;

    upsertReadyEmbedding({
      db,
      memoryId: memory.id,
      providerId: "provider:test",
      vector: [1, 0],
      contentHash: memory.hash!,
    });

    updateMemory(db, memory.id, { content: "更新后的风格约束" });

    const row = getEmbedding(db, memory.id, "provider:test");
    expect(row?.status).toBe("pending");

    const results = searchByVector(db, [1, 0], {
      providerId: "provider:test",
      limit: 5,
    });

    expect(results).toHaveLength(0);
  });
});
