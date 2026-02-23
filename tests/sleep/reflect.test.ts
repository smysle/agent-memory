import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/core/db.js";
import { createMemory } from "../../src/core/memory.js";
import { runDecay } from "../../src/sleep/decay.js";
import { runTidy } from "../../src/sleep/tidy.js";
import { runGovern } from "../../src/sleep/govern.js";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agent-memory-reflect-test.db";

describe("Reflect report support data", () => {
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

  it("produces decay/tidy/govern summaries consumable by markdown report", () => {
    const mem = createMemory(db, { content: "old event", type: "event" })!;
    db.prepare("UPDATE memories SET created_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(mem.id);

    const decay = runDecay(db);
    expect(decay).toHaveProperty("updated");

    db.prepare("UPDATE memories SET vitality = 0.01 WHERE id = ?").run(mem.id);
    const tidy = runTidy(db);
    expect(tidy).toHaveProperty("archived");

    const govern = runGovern(db);
    expect(govern).toHaveProperty("orphanPaths");
    expect(govern).toHaveProperty("emptyMemories");
  });
});
