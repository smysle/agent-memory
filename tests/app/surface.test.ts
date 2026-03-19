import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";
import { openDatabase } from "../../src/core/db.js";
import { createMemory } from "../../src/core/memory.js";
import { upsertReadyEmbedding } from "../../src/search/vector.js";
import type { EmbeddingProvider } from "../../src/search/embedding.js";
import { surfaceMemories } from "../../src/app/surface.js";
import { recordFeedbackEvent } from "../../src/app/feedback.js";

const TEST_DB = "/tmp/agent-memory-app-surface-test.db";

function createStubProvider(vectors: Record<string, number[]>, id = "provider:surface-stub"): EmbeddingProvider {
  return {
    id,
    model: "stub",
    dimension: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => vectors[text] ?? [0, 0]);
    },
  };
}

describe("context-aware surface", () => {
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

  it("uses query context to outrank static vitality/priority ordering", async () => {
    const identity = createMemory(db, { content: "Alice is the sole contractor", type: "identity" })!;
    const design = createMemory(db, { content: "UI 设计要克制低饱和，避免玻璃拟态", type: "knowledge" })!;

    const provider = createStubProvider({
      "glassmorphism style": [1, 0],
    });

    upsertReadyEmbedding({
      db,
      memoryId: design.id,
      providerId: provider.id,
      vector: [1, 0],
      contentHash: design.hash!,
    });
    upsertReadyEmbedding({
      db,
      memoryId: identity.id,
      providerId: provider.id,
      vector: [0, 1],
      contentHash: identity.hash!,
    });

    const withoutQuery = await surfaceMemories(db, { limit: 2, provider: null });
    expect(withoutQuery.results[0]?.memory.id).toBe(identity.id);

    const withQuery = await surfaceMemories(db, {
      query: "glassmorphism style",
      limit: 2,
      provider,
    });
    expect(withQuery.results[0]?.memory.id).toBe(design.id);
    expect(withQuery.results[0]?.reason_codes).toContain("semantic:glassmorphism");
  });

  it("changes ranking based on intent when query is absent", async () => {
    const preference = createMemory(db, { content: "偏好：喜欢克制、低饱和的 UI 风格", type: "identity" })!;
    const planning = createMemory(db, { content: "规划：先写设计文档，再实现 HTTP API", type: "knowledge" })!;

    const preferenceSurface = await surfaceMemories(db, {
      intent: "preference",
      limit: 2,
      provider: null,
    });
    expect(preferenceSurface.results[0]?.memory.id).toBe(preference.id);
    expect(preferenceSurface.results[0]?.reason_codes).toContain("intent:preference");

    const planningSurface = await surfaceMemories(db, {
      intent: "planning",
      limit: 2,
      provider: null,
    });
    expect(planningSurface.results[0]?.memory.id).toBe(planning.id);
    expect(planningSurface.results[0]?.reason_codes).toContain("intent:planning");
  });

  it("boosts memories with positive usefulness feedback", async () => {
    const provider = createStubProvider({
      "style rules": [1, 0],
    });

    const negative = createMemory(db, { content: "UI 风格要克制，避免玻璃拟态", type: "knowledge" })!;
    const positive = createMemory(db, { content: "界面风格要克制，避免蓝紫渐变", type: "knowledge" })!;

    for (const memory of [negative, positive]) {
      upsertReadyEmbedding({
        db,
        memoryId: memory.id,
        providerId: provider.id,
        vector: [1, 0],
        contentHash: memory.hash!,
      });
    }

    recordFeedbackEvent(db, { memory_id: negative.id, source: "surface", useful: false });
    recordFeedbackEvent(db, { memory_id: negative.id, source: "surface", useful: false });
    recordFeedbackEvent(db, { memory_id: positive.id, source: "surface", useful: true });
    recordFeedbackEvent(db, { memory_id: positive.id, source: "surface", useful: true });

    const result = await surfaceMemories(db, {
      query: "style rules",
      limit: 2,
      provider,
    });

    expect(result.results[0]?.memory.id).toBe(positive.id);
    expect(result.results[0]?.feedback_score).toBeGreaterThan(result.results[1]?.feedback_score ?? 0);
    expect(result.results[0]?.reason_codes).toContain("feedback:reinforced");
    expect(result.results[1]?.reason_codes).toContain("feedback:negative");
  });
});
