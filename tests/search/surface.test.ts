import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/core/db.js";
import { createMemory, getMemory } from "../../src/core/memory.js";
import { searchBM25 } from "../../src/search/bm25.js";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agent-memory-surface-test.db";

describe("Surface scoring behavior", () => {
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

  it("computes priority×vitality×hitRatio ordering", () => {
    const id = createMemory(db, { content: "Noah love memory", type: "identity" })!;
    const em = createMemory(db, { content: "love memory", type: "emotion" })!;

    const keywords = ["Noah", "love"];
    const candidates = new Map<string, { id: string; hits: number; priority: number; vitality: number }>();

    for (const kw of keywords) {
      const results = searchBM25(db, kw, { limit: 50 });
      for (const r of results) {
        const prev = candidates.get(r.memory.id);
        if (prev) {
          prev.hits += 1;
        } else {
          candidates.set(r.memory.id, {
            id: r.memory.id,
            hits: 1,
            priority: r.memory.priority,
            vitality: r.memory.vitality,
          });
        }
      }
    }

    const scored = [...candidates.values()]
      .map((c) => {
        const weight = [4.0, 3.0, 2.0, 1.0][c.priority] ?? 1.0;
        return { ...c, score: weight * c.vitality * (c.hits / keywords.length) };
      })
      .sort((a, b) => b.score - a.score);

    expect(scored[0].id).toBe(id.id);
    expect(scored[1].id).toBe(em.id);
  });

  it("does not change last_accessed in readonly lookup path", () => {
    const m = createMemory(db, { content: "readonly check", type: "knowledge" })!;
    const before = getMemory(db, m.id)!;
    expect(before.last_accessed).toBeNull();

    // readonly lookup (search only, no recordAccess)
    searchBM25(db, "readonly check", { limit: 5 });

    const after = getMemory(db, m.id)!;
    expect(after.last_accessed).toBeNull();
  });
});
