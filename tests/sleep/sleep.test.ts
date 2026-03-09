import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { readFileSync, rmSync, unlinkSync } from "fs";
import { openDatabase } from "../../src/core/db.js";
import { exportMemories } from "../../src/core/export.js";
import { createMemory, getMemory, listMemories } from "../../src/core/memory.js";
import { createPath } from "../../src/core/path.js";
import { boot } from "../../src/sleep/boot.js";
import { runDecay } from "../../src/sleep/decay.js";
import { runGovern } from "../../src/sleep/govern.js";
import { syncBatch, syncOne } from "../../src/sleep/sync.js";
import { runTidy } from "../../src/sleep/tidy.js";

const TEST_DB = "/tmp/agent-memory-sleep-test.db";

describe("Sleep Cycle", () => {
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

  it("syncOne adds/skips/updates", async () => {
    const first = await syncOne(db, { content: "Original identity memory content", type: "identity", uri: "core://test" });
    expect(first.action).toBe("added");

    const duplicate = await syncOne(db, { content: "Original identity memory content", type: "identity", uri: "core://test" });
    expect(["skipped", "updated", "merged"]).toContain(duplicate.action);

    const second = await syncOne(db, { content: "Updated identity memory version", type: "identity", uri: "core://test" });
    expect(second.action).toBe("updated");
  });

  it("syncBatch processes multiple items", async () => {
    const results = await syncBatch(db, [
      { content: "batch item 1", type: "event" },
      { content: "completely different event note", type: "event" },
      { content: "batch item 1", type: "event" },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].action).toBe("added");
    expect(["added", "merged"]).toContain(results[1].action);
    expect(results[2].action).toBe("skipped");
  });

  it("tidy archives decayed P3 while govern cleans orphan paths", () => {
    const mem = createMemory(db, { content: "old event to archive", type: "event" })!;
    db.prepare("UPDATE memories SET vitality = 0.01 WHERE id = ?").run(mem.id);

    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO paths (id, memory_id, agent_id, uri, domain, created_at) VALUES (?,?,?,?,?,?)")
      .run("orphan-path", "nonexistent-memory-id", "default", "event://orphan", "event", new Date().toISOString());
    db.pragma("foreign_keys = ON");

    const tidy = runTidy(db);
    expect(tidy.archived).toBe(1);
    expect(tidy.orphansCleaned).toBe(0);
    expect(getMemory(db, mem.id)).toBeNull();

    const govern = runGovern(db);
    expect(govern.orphanPaths).toBe(1);
  });

  it("govern removes orphan paths and empty memories", () => {
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO paths (id, memory_id, agent_id, uri, domain, created_at) VALUES (?,?,?,?,?,?)")
      .run("orphan-path-g", "missing-memory", "default", "event://orphan-g", "event", new Date().toISOString());
    db.pragma("foreign_keys = ON");

    db.prepare(
      "INSERT INTO memories (id, content, type, priority, emotion_val, vitality, stability, access_count, created_at, updated_at, agent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run("empty-id", "  ", "event", 3, 0, 1, 14, 0, new Date().toISOString(), new Date().toISOString(), "default");

    const result = runGovern(db);
    expect(result.orphanPaths).toBe(1);
    expect(result.emptyMemories).toBe(1);
  });

  it("boot loads identity and core path memories", () => {
    createMemory(db, { content: "I am Noah", type: "identity" });
    const mem = createMemory(db, { content: "Agent personality", type: "knowledge" })!;
    createPath(db, mem.id, "core://agent");

    const result = boot(db);
    expect(result.identityMemories.some((memory) => memory.type === "identity")).toBe(true);
    expect(result.identityMemories.some((memory) => memory.id === mem.id)).toBe(true);
  });

  it("full cycle works", async () => {
    await syncBatch(db, [
      { content: "I am Noah", type: "identity", uri: "core://agent" },
      { content: "Xiaoxin said he loves me", type: "emotion", uri: "emotion://love/1" },
      { content: "Configured mihomo proxy", type: "event" },
      { content: "Installed search-layer", type: "event" },
    ]);

    db.prepare("UPDATE memories SET created_at = '2025-01-01T00:00:00.000Z' WHERE type = 'event'").run();
    const decayResult = runDecay(db);
    expect(decayResult.updated).toBeGreaterThan(0);

    const tidyResult = runTidy(db);
    expect(tidyResult.archived).toBeGreaterThan(0);

    const governResult = runGovern(db);
    expect(governResult.orphanPaths).toBe(0);

    const remaining = listMemories(db);
    expect(remaining.some((memory) => memory.type === "identity")).toBe(true);
    expect(remaining.some((memory) => memory.type === "emotion")).toBe(true);
  });

  it("exports memories to markdown files", () => {
    const exportDir = "/tmp/agent-memory-export-test";
    try { rmSync(exportDir, { recursive: true }); } catch {}

    createMemory(db, { content: "I am Noah", type: "identity" });
    createMemory(db, { content: "Love is important", type: "emotion" });
    createMemory(db, { content: "TypeScript is great", type: "knowledge" });

    const result = exportMemories(db, exportDir);
    expect(result.exported).toBe(3);

    const memoryMd = readFileSync(`${exportDir}/MEMORY.md`, "utf-8");
    expect(memoryMd).toContain("I am Noah");

    try { rmSync(exportDir, { recursive: true }); } catch {}
  });
});
