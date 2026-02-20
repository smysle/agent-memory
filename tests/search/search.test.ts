import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/core/db.js";
import { createMemory } from "../../src/core/memory.js";
import { searchBM25 } from "../../src/search/bm25.js";
import { classifyIntent, getStrategy } from "../../src/search/intent.js";
import { rerank } from "../../src/search/rerank.js";
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

  // ── BM25 Search ──

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

  // ── Intent Classification ──

  it("classifies factual queries", () => {
    expect(classifyIntent("小心的名字是什么").intent).toBe("factual");
    expect(classifyIntent("what is the config").intent).toBe("factual");
  });

  it("classifies temporal queries", () => {
    expect(classifyIntent("昨天发生了什么").intent).toBe("temporal");
    expect(classifyIntent("when did we last talk").intent).toBe("temporal");
  });

  it("classifies causal queries", () => {
    expect(classifyIntent("为什么要用 TypeScript").intent).toBe("causal");
    expect(classifyIntent("why did the build fail").intent).toBe("causal");
  });

  it("classifies exploratory queries", () => {
    expect(classifyIntent("说说关于记忆系统").intent).toBe("exploratory");
    expect(classifyIntent("tell me about the memory architecture").intent).toBe("exploratory");
  });

  it("returns strategy based on intent", () => {
    const factual = getStrategy("factual");
    expect(factual.boostPriority).toBe(true);
    expect(factual.limit).toBe(5);

    const temporal = getStrategy("temporal");
    expect(temporal.boostRecent).toBe(true);
  });

  // ── Reranking ──

  it("boosts high-priority results when boostPriority is true", () => {
    createMemory(db, { content: "Noah is a succubus demon", type: "identity" }); // P0
    createMemory(db, { content: "Noah wrote code today for testing", type: "event" }); // P3

    const results = searchBM25(db, "Noah");
    expect(results.length).toBe(2);

    const reranked = rerank(results, {
      intent: "factual",
      boostRecent: false,
      boostPriority: true,
      limit: 10,
    });

    // P0 should be ranked first
    expect(reranked[0].memory.priority).toBe(0);
  });

  // ── Ebbinghaus Decay ──

  it("P0 identity never decays", () => {
    const v = calculateVitality(999999, 3650, 0); // 10 years
    expect(v).toBe(1.0);
  });

  it("P1 emotion decays slowly", () => {
    const v30 = calculateVitality(365, 30, 1);
    expect(v30).toBeGreaterThan(0.9); // 30 days, S=365 → barely decayed

    const v365 = calculateVitality(365, 365, 1);
    expect(v365).toBeGreaterThan(0.3); // 1 year → above minimum

    // Minimum floor
    const v9999 = calculateVitality(365, 9999, 1);
    expect(v9999).toBeGreaterThanOrEqual(0.3);
  });

  it("P3 event decays fast", () => {
    const v7 = calculateVitality(14, 7, 3);
    expect(v7).toBeGreaterThan(0.5);
    expect(v7).toBeLessThan(0.7);

    const v30 = calculateVitality(14, 30, 3);
    expect(v30).toBeLessThan(0.15);
  });

  it("runDecay updates vitality in batch", () => {
    // Create a P3 memory with fake old date
    const mem = createMemory(db, { content: "old event", type: "event" })!;
    // Manually backdate it
    db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
      "2025-01-01T00:00:00.000Z",
      mem.id,
    );

    const result = runDecay(db);
    expect(result.updated).toBeGreaterThan(0);
    expect(result.decayed).toBeGreaterThan(0);
  });

  it("runDecay uses last_accessed instead of created_at when available", () => {
    // Create a P3 memory with old created_at but recent last_accessed
    const mem = createMemory(db, { content: "accessed recently", type: "event" })!;
    const recentDate = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1 hour ago
    db.prepare("UPDATE memories SET created_at = ?, last_accessed = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z", // very old creation
      recentDate,                  // but accessed recently
      mem.id,
    );

    runDecay(db);
    const updated = (db.prepare("SELECT vitality FROM memories WHERE id = ?").get(mem.id) as { vitality: number });
    // Should still have high vitality because last_accessed is recent
    expect(updated.vitality).toBeGreaterThan(0.9);
  });

  it("runDecay falls back to created_at when last_accessed is null", () => {
    const mem = createMemory(db, { content: "never accessed event", type: "event" })!;
    // Old created_at, no last_accessed
    db.prepare("UPDATE memories SET created_at = ?, last_accessed = NULL WHERE id = ?").run(
      "2025-01-01T00:00:00.000Z",
      mem.id,
    );

    runDecay(db);
    const updated = (db.prepare("SELECT vitality FROM memories WHERE id = ?").get(mem.id) as { vitality: number });
    // Should have decayed significantly (old creation, never accessed)
    expect(updated.vitality).toBeLessThan(0.5);
  });
});
