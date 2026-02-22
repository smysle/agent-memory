import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase } from "../../src/core/db.js";
import { createMemory } from "../../src/core/memory.js";
import { embedMemory } from "../../src/search/embed.js";
import { searchHybrid } from "../../src/search/hybrid.js";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agent-memory-hybrid-test.db";

const mockProvider = {
  id: "mock",
  model: "mock-1",
  async embed(text: string) {
    // Treat 开心/高兴 as the same "concept" vector.
    if (text.includes("开心") || text.includes("高兴")) return [1, 0, 0];
    return [0, 1, 0];
  },
  async embedQuery(query: string) {
    return this.embed(`Instruct: test\nQuery: ${query}`);
  },
};

describe("Hybrid Search", () => {
  let db: Database.Database;

  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
    db = openDatabase({ path: TEST_DB });
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("uses embedQuery when provided", async () => {
    const m = createMemory(db, { content: "我今天很高兴", type: "emotion" })!;

    await embedMemory(db, m.id, mockProvider as any, { agent_id: "default" });

    const embedQuerySpy = vi.spyOn(mockProvider, "embedQuery");
    const embedSpy = vi.spyOn(mockProvider, "embed");

    const results = await searchHybrid(db, "开心", { agent_id: "default", embeddingProvider: mockProvider as any, limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(embedQuerySpy).toHaveBeenCalledOnce();
    // embed() is still used for indexing; here we only assert query path goes through embedQuery.
    expect(embedSpy).toHaveBeenCalled();
  });
});

