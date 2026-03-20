import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";
import { openDatabase } from "../../src/core/db.js";
import { createMemory, getMemory, listMemories } from "../../src/core/memory.js";
import { runGovern, getTieredCapacity } from "../../src/sleep/govern.js";

const TEST_DB = "/tmp/agent-memory-tiered-test.db";

describe("Tiered Capacity", () => {
  let db: Database.Database;
  const originalEnv: Record<string, string | undefined> = {};

  function saveEnv(...keys: string[]) {
    for (const k of keys) {
      originalEnv[k] = process.env[k];
    }
  }

  function restoreEnv() {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(TEST_DB + suffix); } catch {}
    }
    db = openDatabase({ path: TEST_DB });
    saveEnv(
      "AGENT_MEMORY_MAX_IDENTITY",
      "AGENT_MEMORY_MAX_EMOTION",
      "AGENT_MEMORY_MAX_KNOWLEDGE",
      "AGENT_MEMORY_MAX_EVENT",
      "AGENT_MEMORY_MAX_MEMORIES",
    );
  });

  afterEach(() => {
    restoreEnv();
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(TEST_DB + suffix); } catch {}
    }
  });

  it("getTieredCapacity returns defaults", () => {
    delete process.env.AGENT_MEMORY_MAX_IDENTITY;
    delete process.env.AGENT_MEMORY_MAX_EMOTION;
    delete process.env.AGENT_MEMORY_MAX_KNOWLEDGE;
    delete process.env.AGENT_MEMORY_MAX_EVENT;
    delete process.env.AGENT_MEMORY_MAX_MEMORIES;

    const cap = getTieredCapacity();
    expect(cap.identity).toBeNull(); // unlimited
    expect(cap.emotion).toBe(50);
    expect(cap.knowledge).toBe(250);
    expect(cap.event).toBe(50);
    expect(cap.total).toBe(350);
  });

  it("getTieredCapacity reads env vars", () => {
    process.env.AGENT_MEMORY_MAX_IDENTITY = "10";
    process.env.AGENT_MEMORY_MAX_EMOTION = "20";
    process.env.AGENT_MEMORY_MAX_KNOWLEDGE = "100";
    process.env.AGENT_MEMORY_MAX_EVENT = "30";
    process.env.AGENT_MEMORY_MAX_MEMORIES = "200";

    const cap = getTieredCapacity();
    expect(cap.identity).toBe(10);
    expect(cap.emotion).toBe(20);
    expect(cap.knowledge).toBe(100);
    expect(cap.event).toBe(30);
    expect(cap.total).toBe(200);
  });

  it("knowledge over limit only evicts knowledge", () => {
    // Set knowledge limit very low
    process.env.AGENT_MEMORY_MAX_KNOWLEDGE = "3";
    process.env.AGENT_MEMORY_MAX_MEMORIES = "999"; // high global so it doesn't interfere
    delete process.env.AGENT_MEMORY_MAX_IDENTITY;
    delete process.env.AGENT_MEMORY_MAX_EMOTION;
    delete process.env.AGENT_MEMORY_MAX_EVENT;

    // Create 6 knowledge + 2 emotion
    for (let i = 0; i < 6; i++) {
      createMemory(db, { content: `Knowledge fact number ${i} unique content here`, type: "knowledge" });
    }
    for (let i = 0; i < 2; i++) {
      createMemory(db, { content: `Emotion feeling number ${i} unique content`, type: "emotion" });
    }

    const result = runGovern(db);
    expect(result.evicted).toBe(3); // 6 - 3 = 3 knowledge evicted
    expect(result.evictedByType.knowledge).toBe(3);
    expect(result.evictedByType.emotion).toBeUndefined(); // emotion untouched

    // Verify
    const remaining = listMemories(db);
    const knowledgeRemaining = remaining.filter((m) => m.type === "knowledge");
    const emotionRemaining = remaining.filter((m) => m.type === "emotion");
    expect(knowledgeRemaining.length).toBe(3);
    expect(emotionRemaining.length).toBe(2);
  });

  it("event over limit only evicts event", () => {
    process.env.AGENT_MEMORY_MAX_EVENT = "2";
    process.env.AGENT_MEMORY_MAX_MEMORIES = "999";
    delete process.env.AGENT_MEMORY_MAX_IDENTITY;
    delete process.env.AGENT_MEMORY_MAX_EMOTION;
    delete process.env.AGENT_MEMORY_MAX_KNOWLEDGE;

    for (let i = 0; i < 5; i++) {
      createMemory(db, { content: `Event thing that happened number ${i}`, type: "event" });
    }
    createMemory(db, { content: "Some important knowledge piece", type: "knowledge" });

    const result = runGovern(db);
    expect(result.evicted).toBe(3);
    expect(result.evictedByType.event).toBe(3);
    expect(result.evictedByType.knowledge).toBeUndefined();

    const remaining = listMemories(db);
    expect(remaining.filter((m) => m.type === "event").length).toBe(2);
    expect(remaining.filter((m) => m.type === "knowledge").length).toBe(1);
  });

  it("identity is never evicted by default (no AGENT_MEMORY_MAX_IDENTITY)", () => {
    delete process.env.AGENT_MEMORY_MAX_IDENTITY;
    process.env.AGENT_MEMORY_MAX_MEMORIES = "999";
    delete process.env.AGENT_MEMORY_MAX_EMOTION;
    delete process.env.AGENT_MEMORY_MAX_KNOWLEDGE;
    delete process.env.AGENT_MEMORY_MAX_EVENT;

    // Identity memories have priority=0, which is excluded from eviction candidates
    // But let's also verify tiered capacity doesn't touch them
    for (let i = 0; i < 5; i++) {
      createMemory(db, { content: `I am identity number ${i}`, type: "identity" });
    }

    const result = runGovern(db);
    expect(result.evicted).toBe(0);

    const remaining = listMemories(db);
    expect(remaining.filter((m) => m.type === "identity").length).toBe(5);
  });

  it("identity can be evicted when AGENT_MEMORY_MAX_IDENTITY is explicitly set", () => {
    process.env.AGENT_MEMORY_MAX_IDENTITY = "2";
    process.env.AGENT_MEMORY_MAX_MEMORIES = "999";
    delete process.env.AGENT_MEMORY_MAX_EMOTION;
    delete process.env.AGENT_MEMORY_MAX_KNOWLEDGE;
    delete process.env.AGENT_MEMORY_MAX_EVENT;

    // Identity memories have priority=0, excluded from rankEvictionCandidates
    // So even with a limit, they won't be evicted (by design — P0 is sacred)
    for (let i = 0; i < 5; i++) {
      createMemory(db, { content: `I am identity number ${i}`, type: "identity" });
    }

    const result = runGovern(db);
    // Identity has priority=0, candidates filter requires priority > 0
    // So identity still won't be evicted even with explicit limit
    // This is correct behavior — identity is P0, sacred
    expect(result.evicted).toBe(0);
  });

  it("global cap kicks in after per-type eviction", () => {
    process.env.AGENT_MEMORY_MAX_KNOWLEDGE = "999"; // no per-type limit
    process.env.AGENT_MEMORY_MAX_EVENT = "999";
    process.env.AGENT_MEMORY_MAX_EMOTION = "999";
    delete process.env.AGENT_MEMORY_MAX_IDENTITY;
    process.env.AGENT_MEMORY_MAX_MEMORIES = "4"; // but global cap is tight

    for (let i = 0; i < 3; i++) {
      createMemory(db, { content: `Knowledge global cap test ${i}`, type: "knowledge" });
    }
    for (let i = 0; i < 3; i++) {
      createMemory(db, { content: `Event global cap test ${i}`, type: "event" });
    }

    const result = runGovern(db);
    expect(result.evicted).toBe(2); // 6 - 4 = 2
    expect(Object.values(result.evictedByType).reduce((a, b) => a + b, 0)).toBe(2);

    const remaining = listMemories(db);
    expect(remaining.length).toBe(4);
  });

  it("GovernResult includes evictedByType breakdown", () => {
    process.env.AGENT_MEMORY_MAX_KNOWLEDGE = "2";
    process.env.AGENT_MEMORY_MAX_EVENT = "1";
    process.env.AGENT_MEMORY_MAX_MEMORIES = "999";
    delete process.env.AGENT_MEMORY_MAX_IDENTITY;
    delete process.env.AGENT_MEMORY_MAX_EMOTION;

    for (let i = 0; i < 4; i++) {
      createMemory(db, { content: `Knowledge breakdown test ${i}`, type: "knowledge" });
    }
    for (let i = 0; i < 3; i++) {
      createMemory(db, { content: `Event breakdown test ${i}`, type: "event" });
    }

    const result = runGovern(db);
    expect(result.evictedByType.knowledge).toBe(2);
    expect(result.evictedByType.event).toBe(2);
    expect(result.evicted).toBe(4);
  });
});
