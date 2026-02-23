import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/core/db.js";
import { createMemory, getMemory } from "../../src/core/memory.js";
import { searchBM25 } from "../../src/search/bm25.js";
import { calculateVitality, runDecay } from "../../src/sleep/decay.js";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agent-memory-search-test.db";

describe("Search & Decay", () => {
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

  it("finds memories by BM25 search", () => {
    createMemory(db, { content: "xiaoxin is my contractor and he is gentle", type: "identity" });
    createMemory(db, { content: "TypeScript is better than Python for agents", type: "knowledge" });
    createMemory(db, { content: "today configured mihomo proxy for xiaoxin", type: "event" });

    const results = searchBM25(db, "xiaoxin contractor");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memory.content).toContain("contractor");
  });

  it("returns empty for no match", () => {
    createMemory(db, { content: "some content", type: "event" });
    const results = searchBM25(db, "完全不相关的查询词汇XYZ");
    expect(results).toHaveLength(0);
  });

  it("weighted ordering uses priority × vitality", () => {
    const p0 = createMemory(db, { content: "Noah memory topic", type: "identity" })!;
    const p3 = createMemory(db, { content: "Noah memory topic event", type: "event" })!;
    // make p3 still somewhat vital
    expect(p0.priority).toBe(0);
    expect(p3.priority).toBe(3);

    const results = searchBM25(db, "Noah memory topic", { limit: 10 });
    const weighted = results
      .map((r) => {
        const weight = [4.0, 3.0, 2.0, 1.0][r.memory.priority] ?? 1.0;
        return { ...r, weighted: r.score * weight * Math.max(0.1, r.memory.vitality) };
      })
      .sort((a, b) => b.weighted - a.weighted);

    expect(weighted[0].memory.priority).toBe(0);
  });

  it("P0 identity never decays", () => {
    const v = calculateVitality(999999, 3650, 0);
    expect(v).toBe(1.0);
  });

  it("P1 emotion decays slowly with floor", () => {
    const v30 = calculateVitality(365, 30, 1);
    expect(v30).toBeGreaterThan(0.9);

    const v9999 = calculateVitality(365, 9999, 1);
    expect(v9999).toBeGreaterThanOrEqual(0.3);
  });

  it("P3 event decays fast", () => {
    const v30 = calculateVitality(14, 30, 3);
    expect(v30).toBeLessThan(0.15);
  });

  it("runDecay updates vitality using last_accessed when available", () => {
    const mem = createMemory(db, { content: "accessed recently", type: "event" })!;
    const recentDate = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    db.prepare("UPDATE memories SET created_at = ?, last_accessed = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      recentDate,
      mem.id,
    );

    runDecay(db);
    const updated = getMemory(db, mem.id)!;
    expect(updated.vitality).toBeGreaterThan(0.9);
  });
});
