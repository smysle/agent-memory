import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";
import { openDatabase } from "../../src/core/db.js";
import { createMemory } from "../../src/core/memory.js";
import { createPath } from "../../src/core/path.js";
import { guard } from "../../src/core/guard.js";
import type { EmbeddingProvider } from "../../src/search/embedding.js";
import { upsertReadyEmbedding } from "../../src/search/vector.js";

const TEST_DB = "/tmp/agent-memory-guard-semantic-test.db";

function createStubProvider(vectors: Record<string, number[]>): EmbeddingProvider {
  return {
    id: "provider:guard-stub",
    model: "stub",
    dimension: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => vectors[text] ?? [0, 0]);
    },
  };
}

describe("semantic guard pipeline", () => {
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

  it("merges paraphrased knowledge memories via semantic dedup", async () => {
    const provider = createStubProvider({
      "界面保持克制，避免玻璃拟态和蓝紫渐变。": [0.92, 0.39],
    });

    const memory = createMemory(db, {
      content: "界面要克制，避免蓝紫渐变和玻璃拟态。",
      type: "knowledge",
    })!;
    createPath(db, memory.id, "knowledge://prefs/ui-style");
    upsertReadyEmbedding({
      db,
      memoryId: memory.id,
      providerId: provider.id,
      vector: [1, 0],
      contentHash: memory.hash!,
    });

    const result = await guard(db, {
      content: "界面保持克制，避免玻璃拟态和蓝紫渐变。",
      type: "knowledge",
      uri: "knowledge://prefs/ui-style-2",
      provider,
    });

    expect(result.action).toBe("merge");
    expect(result.mergePlan?.strategy).toBe("synthesize");
    expect(result.score?.dedup_score).toBeGreaterThanOrEqual(0.82);
  });

  it("keeps different event windows as add even when semantically related", async () => {
    const provider = createStubProvider({
      "2026-03-01 再次上线 reflect 编排器": [0.83, 0.55],
    });

    const memory = createMemory(db, {
      content: "2026-02-01 发布 reflect 编排器",
      type: "event",
    })!;
    createPath(db, memory.id, "event://2026-02-01/reflect");
    upsertReadyEmbedding({
      db,
      memoryId: memory.id,
      providerId: provider.id,
      vector: [1, 0],
      contentHash: memory.hash!,
    });

    const result = await guard(db, {
      content: "2026-03-01 再次上线 reflect 编排器",
      type: "event",
      uri: "event://2026-03-01/reflect",
      provider,
      now: "2026-03-01T00:00:00.000Z",
    });

    expect(result.action).toBe("add");
    expect(result.score?.dedup_score ?? 0).toBeLessThan(0.82);
  });

  it("skips exact duplicates before semantic scoring", async () => {
    createMemory(db, { content: "Alice prefers low-saturation UI", type: "identity" });

    const result = await guard(db, {
      content: "Alice prefers low-saturation UI",
      type: "identity",
    });

    expect(result.action).toBe("skip");
    expect(result.reason).toContain("Exact duplicate");
  });
});
