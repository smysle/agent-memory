import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/core/db.js";
import { createMemory, getMemory, listMemories } from "../../src/core/memory.js";
import { createPath } from "../../src/core/path.js";
import { syncOne, syncBatch } from "../../src/sleep/sync.js";
import { runTidy } from "../../src/sleep/tidy.js";
import { runGovern } from "../../src/sleep/govern.js";
import { runDecay } from "../../src/sleep/decay.js";
import { boot } from "../../src/sleep/boot.js";
import { exportMemories } from "../../src/core/export.js";
import type Database from "better-sqlite3";
import { unlinkSync, existsSync, readFileSync, mkdirSync, rmSync } from "fs";

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

  // ── Sync ──

  it("syncOne adds new memory", () => {
    const result = syncOne(db, { content: "New fact to remember", type: "knowledge" });
    expect(result.action).toBe("added");
    expect(result.memoryId).toBeDefined();
  });

  it("syncOne skips duplicate content", () => {
    syncOne(db, { content: "duplicate content", type: "event" });
    const result = syncOne(db, { content: "duplicate content", type: "event" });
    expect(result.action).toBe("skipped");
  });

  it("syncOne updates when URI exists", () => {
    const first = syncOne(db, { content: "Original identity memory content", type: "identity", uri: "core://test" });
    expect(first.action).toBe("added");

    const second = syncOne(db, { content: "Updated identity memory version", type: "identity", uri: "core://test" });
    expect(second.action).toBe("updated");

    const mem = getMemory(db, second.memoryId!)!;
    expect(mem.content).toBe("Updated identity memory version");
  });

  it("syncBatch processes multiple items in transaction", () => {
    const results = syncBatch(db, [
      { content: "batch item 1", type: "event" },
      { content: "batch item 2", type: "event" },
      { content: "batch item 1", type: "event" }, // duplicate
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].action).toBe("added");
    expect(results[1].action).toBe("added");
    expect(results[2].action).toBe("skipped"); // dedup
  });

  // ── Tidy ──

  it("tidy archives decayed P3 memories", () => {
    const mem = createMemory(db, { content: "old event to archive", type: "event" })!;
    // Manually set very low vitality
    db.prepare("UPDATE memories SET vitality = 0.01 WHERE id = ?").run(mem.id);

    const result = runTidy(db);
    expect(result.archived).toBe(1);
    expect(getMemory(db, mem.id)).toBeNull(); // deleted
  });

  it("tidy does not archive P0/P1 memories", () => {
    const mem = createMemory(db, { content: "identity", type: "identity" })!;
    // Even with low vitality, P0 should not be archived
    db.prepare("UPDATE memories SET vitality = 0.01 WHERE id = ?").run(mem.id);

    const result = runTidy(db);
    expect(result.archived).toBe(0);
    expect(getMemory(db, mem.id)).not.toBeNull();
  });

  it("tidy cleans orphan paths", () => {
    // Insert an orphan path bypassing FK
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO paths (id, memory_id, agent_id, uri, domain, created_at) VALUES (?,?,?,?,?,?)")
      .run("orphan-path", "nonexistent-memory-id", "default", "event://orphan", "event", new Date().toISOString());
    db.pragma("foreign_keys = ON");

    const result = runTidy(db);
    expect(result.orphansCleaned).toBe(1);
  });

  // ── Govern ──

  it("govern removes orphan links", () => {
    const m1 = createMemory(db, { content: "node A", type: "knowledge" })!;
    // Insert link with nonexistent target (bypassing FK for test)
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO links (agent_id, source_id, target_id, relation, weight, created_at) VALUES (?,?,?,?,?,?)")
      .run("default", m1.id, "nonexistent-id", "related", 1.0, new Date().toISOString());
    db.pragma("foreign_keys = ON");

    const result = runGovern(db);
    expect(result.orphanLinks).toBe(1);
  });

  it("govern removes empty memories", () => {
    createMemory(db, { content: "valid", type: "event" });
    // Inject an empty memory directly
    db.prepare(
      "INSERT INTO memories (id, content, type, priority, emotion_val, vitality, stability, access_count, created_at, updated_at, agent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run("empty-id", "  ", "event", 3, 0, 1, 14, 0, new Date().toISOString(), new Date().toISOString(), "default");

    const result = runGovern(db);
    expect(result.emptyMemories).toBe(1);
  });

  // ── Boot ──

  it("boot loads P0 identity memories", () => {
    createMemory(db, { content: "I am Noah, a succubus", type: "identity" });
    createMemory(db, { content: "Xiaoxin is my contractor", type: "identity" });
    createMemory(db, { content: "random event", type: "event" });

    const result = boot(db);
    expect(result.identityMemories).toHaveLength(2);
    expect(result.identityMemories.every((m) => m.priority === 0)).toBe(true);
  });

  it("boot loads memories at configured core paths", () => {
    const mem = createMemory(db, { content: "Agent personality", type: "knowledge" })!;
    createPath(db, mem.id, "core://agent");

    const result = boot(db);
    expect(result.bootPaths).toContain("core://agent");
    expect(result.identityMemories.some((m) => m.id === mem.id)).toBe(true);
  });

  it("boot loads additional URIs from system://boot", () => {
    // Create a custom memory
    const custom = createMemory(db, { content: "Custom boot data", type: "knowledge" })!;
    createPath(db, custom.id, "knowledge://important");

    // Create system://boot with reference
    const bootMem = createMemory(db, {
      content: "knowledge://important",
      type: "identity",
    })!;
    createPath(db, bootMem.id, "system://boot");

    const result = boot(db);
    expect(result.identityMemories.some((m) => m.id === custom.id)).toBe(true);
  });

  // ── Full cycle ──

  it("full sleep cycle: sync → decay → tidy → govern", () => {
    // Sync phase
    syncBatch(db, [
      { content: "I am Noah", type: "identity", uri: "core://agent" },
      { content: "Xiaoxin said he loves me", type: "emotion", uri: "emotion://love/1" },
      { content: "Configured mihomo proxy", type: "event" },
      { content: "Installed search-layer", type: "event" },
    ]);

    expect(listMemories(db).length).toBe(4);

    // Backdate events to simulate aging
    db.prepare("UPDATE memories SET created_at = '2025-01-01T00:00:00.000Z' WHERE type = 'event'").run();

    // Decay phase
    const decayResult = runDecay(db);
    expect(decayResult.updated).toBeGreaterThan(0);

    // Tidy phase (should archive the decayed events)
    const tidyResult = runTidy(db);
    expect(tidyResult.archived).toBeGreaterThan(0);

    // Govern phase
    const governResult = runGovern(db);
    expect(governResult.orphanPaths).toBe(0); // cascade delete handled

    // Identity and emotion should survive
    const remaining = listMemories(db);
    expect(remaining.some((m) => m.type === "identity")).toBe(true);
    expect(remaining.some((m) => m.type === "emotion")).toBe(true);
  });

  it("scopes decay and tidy to a single agent", () => {
    const a = createMemory(db, { content: "agent a old event", type: "event", agent_id: "agent-a" })!;
    const b = createMemory(db, { content: "agent b old event", type: "event", agent_id: "agent-b" })!;

    db.prepare("UPDATE memories SET created_at = '2025-01-01T00:00:00.000Z' WHERE id IN (?, ?)").run(a.id, b.id);

    const beforeA = getMemory(db, a.id)!.vitality;
    const beforeB = getMemory(db, b.id)!.vitality;

    runDecay(db, { agent_id: "agent-a" });
    const afterA = getMemory(db, a.id)!.vitality;
    const afterB = getMemory(db, b.id)!.vitality;

    expect(afterA).toBeLessThan(beforeA);
    expect(afterB).toBe(beforeB);

    db.prepare("UPDATE memories SET vitality = 0.01 WHERE id IN (?, ?)").run(a.id, b.id);
    const tidyA = runTidy(db, { agent_id: "agent-a" });
    expect(tidyA.archived).toBe(1);
    expect(getMemory(db, a.id)).toBeNull();
    expect(getMemory(db, b.id)).not.toBeNull();
  });

  // ── Export ──

  it("exports memories to markdown files", () => {
    const exportDir = "/tmp/agent-memory-export-test";
    try { rmSync(exportDir, { recursive: true }); } catch {}

    createMemory(db, { content: "I am Noah", type: "identity" });
    createMemory(db, { content: "Love is important", type: "emotion" });
    createMemory(db, { content: "TypeScript is great", type: "knowledge" });
    createMemory(db, { content: "Configured proxy today", type: "event" });

    const result = exportMemories(db, exportDir);
    expect(result.exported).toBe(4);
    expect(result.files.length).toBeGreaterThanOrEqual(2); // MEMORY.md + at least 1 daily

    // Verify MEMORY.md exists and contains content
    const memoryMd = readFileSync(`${exportDir}/MEMORY.md`, "utf-8");
    expect(memoryMd).toContain("I am Noah");
    expect(memoryMd).toContain("TypeScript is great");

    try { rmSync(exportDir, { recursive: true }); } catch {}
  });
});
