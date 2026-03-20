import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";
import { openDatabase } from "../../src/core/db.js";
import {
  createMemory,
  getMemory,
  listMemories,
  archiveMemory,
  restoreMemory,
  listArchivedMemories,
  purgeArchive,
  type ArchivedMemory,
} from "../../src/core/memory.js";
import { runGovern, getTieredCapacity } from "../../src/sleep/govern.js";

const TEST_DB = "/tmp/agent-memory-archive-test.db";

describe("Archive on Eviction", () => {
  let db: Database.Database;

  beforeEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(TEST_DB + suffix); } catch {}
    }
    db = openDatabase({ path: TEST_DB });
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(TEST_DB + suffix); } catch {}
    }
  });

  it("schema v8: memory_archive table exists", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_archive'",
    ).get() as { name: string } | undefined;
    expect(tables?.name).toBe("memory_archive");

    const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string };
    expect(version.value).toBe("8");
  });

  it("archiveMemory moves memory to archive table", () => {
    const mem = createMemory(db, { content: "Important knowledge to archive", type: "knowledge" })!;
    expect(mem).toBeTruthy();
    // vitality is 1.0 by default, well above minVitality threshold
    const result = archiveMemory(db, mem.id, "eviction");
    expect(result).toBe("archived");

    // Memory should be gone from main table
    expect(getMemory(db, mem.id)).toBeNull();

    // Memory should be in archive
    const archived = db.prepare("SELECT * FROM memory_archive WHERE id = ?").get(mem.id) as ArchivedMemory;
    expect(archived).toBeTruthy();
    expect(archived.content).toBe("Important knowledge to archive");
    expect(archived.archive_reason).toBe("eviction");
    expect(archived.archived_at).toBeTruthy();
  });

  it("archiveMemory skips archive for low-vitality memories (direct delete)", () => {
    const mem = createMemory(db, { content: "Decayed noise memory", type: "event" })!;
    db.prepare("UPDATE memories SET vitality = 0.05 WHERE id = ?").run(mem.id);

    const result = archiveMemory(db, mem.id, "eviction");
    expect(result).toBe("deleted");

    // Gone from main table
    expect(getMemory(db, mem.id)).toBeNull();
    // NOT in archive (too low vitality)
    const archived = db.prepare("SELECT * FROM memory_archive WHERE id = ?").get(mem.id);
    expect(archived).toBeUndefined();
  });

  it("archiveMemory respects custom minVitality", () => {
    const mem = createMemory(db, { content: "Medium vitality mem", type: "knowledge" })!;
    db.prepare("UPDATE memories SET vitality = 0.3 WHERE id = ?").run(mem.id);

    // With minVitality=0.5, this should be directly deleted
    const result = archiveMemory(db, mem.id, "eviction", { minVitality: 0.5 });
    expect(result).toBe("deleted");
    const archived = db.prepare("SELECT * FROM memory_archive WHERE id = ?").get(mem.id);
    expect(archived).toBeUndefined();
  });

  it("restoreMemory recovers archived memory", () => {
    const mem = createMemory(db, { content: "Restore me please", type: "emotion", emotion_tag: "hope" })!;
    archiveMemory(db, mem.id, "eviction");
    expect(getMemory(db, mem.id)).toBeNull();

    const restored = restoreMemory(db, mem.id);
    expect(restored).toBeTruthy();
    expect(restored!.content).toBe("Restore me please");
    expect(restored!.type).toBe("emotion");
    expect(restored!.emotion_tag).toBe("hope");

    // Should be gone from archive
    const stillArchived = db.prepare("SELECT * FROM memory_archive WHERE id = ?").get(mem.id);
    expect(stillArchived).toBeUndefined();

    // Should be back in main table
    expect(getMemory(db, mem.id)).toBeTruthy();

    // FTS should work
    const ftsResult = db.prepare("SELECT id FROM memories_fts WHERE content MATCH ?").all("restore") as Array<{ id: string }>;
    expect(ftsResult.some((r) => r.id === mem.id)).toBe(true);
  });

  it("restoreMemory returns null for non-existent archive", () => {
    expect(restoreMemory(db, "nonexistent-id")).toBeNull();
  });

  it("listArchivedMemories returns archived memories", () => {
    const m1 = createMemory(db, { content: "Archive item one", type: "knowledge" })!;
    const m2 = createMemory(db, { content: "Archive item two", type: "event" })!;
    archiveMemory(db, m1.id, "eviction");
    archiveMemory(db, m2.id, "eviction");

    const archived = listArchivedMemories(db);
    expect(archived.length).toBe(2);
    expect(archived.every((a) => a.archived_at !== undefined)).toBe(true);
  });

  it("listArchivedMemories respects agent_id filter", () => {
    const m1 = createMemory(db, { content: "Agent A memory", type: "knowledge", agent_id: "agent-a" })!;
    const m2 = createMemory(db, { content: "Agent B memory", type: "knowledge", agent_id: "agent-b" })!;
    archiveMemory(db, m1.id, "eviction");
    archiveMemory(db, m2.id, "eviction");

    const archivedA = listArchivedMemories(db, { agent_id: "agent-a" });
    expect(archivedA.length).toBe(1);
    expect(archivedA[0].content).toBe("Agent A memory");
  });

  it("purgeArchive permanently deletes all archived memories", () => {
    const m1 = createMemory(db, { content: "Purge me one", type: "knowledge" })!;
    const m2 = createMemory(db, { content: "Purge me two", type: "event" })!;
    archiveMemory(db, m1.id, "eviction");
    archiveMemory(db, m2.id, "eviction");

    const purged = purgeArchive(db);
    expect(purged).toBe(2);

    const remaining = listArchivedMemories(db);
    expect(remaining.length).toBe(0);
  });

  it("govern eviction archives memories to archive table", () => {
    // Create more memories than the limit
    for (let i = 0; i < 8; i++) {
      createMemory(db, { content: `Knowledge item number ${i} with unique content`, type: "knowledge" });
    }

    // Run govern with a very small limit to force eviction
    const result = runGovern(db, { maxMemories: 5 });
    expect(result.evicted).toBe(3);
    // archived should be <= evicted (low-vitality ones are directly deleted)
    expect(result.archived).toBeLessThanOrEqual(result.evicted);
    expect(result.archived).toBeGreaterThan(0); // fresh memories have vitality=1.0, should be archived

    // Check archive table has entries
    const archived = listArchivedMemories(db);
    expect(archived.length).toBe(result.archived);

    // Remaining memories should be within limit
    const remaining = listMemories(db);
    expect(remaining.length).toBe(5);
  });
});
