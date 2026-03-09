import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/core/db.js";
import { createMemory, getMemory, updateMemory, deleteMemory, listMemories, recordAccess, countMemories } from "../../src/core/memory.js";
import { createPath, getPathByUri, getPathsByPrefix } from "../../src/core/path.js";
import { guard } from "../../src/core/guard.js";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agent-memory-test.db";

describe("AgentMemory Core", () => {
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

  it("creates and retrieves a memory", () => {
    const mem = createMemory(db, { content: "小心是我的契约者", type: "identity" });
    expect(mem).not.toBeNull();
    expect(mem!.type).toBe("identity");
    expect(mem!.priority).toBe(0);

    const fetched = getMemory(db, mem!.id);
    expect(fetched?.content).toBe("小心是我的契约者");
  });

  it("deduplicates identical content", () => {
    const m1 = createMemory(db, { content: "test dedup", type: "event" });
    const m2 = createMemory(db, { content: "test dedup", type: "event" });
    expect(m1).not.toBeNull();
    expect(m2).toBeNull();
  });

  it("marks embeddings dirty when a provider is configured", () => {
    const previous = {
      provider: process.env.AGENT_MEMORY_EMBEDDING_PROVIDER,
      baseUrl: process.env.AGENT_MEMORY_EMBEDDING_BASE_URL,
      apiKey: process.env.AGENT_MEMORY_EMBEDDING_API_KEY,
      model: process.env.AGENT_MEMORY_EMBEDDING_MODEL,
      dimension: process.env.AGENT_MEMORY_EMBEDDING_DIMENSION,
    };

    try {
      process.env.AGENT_MEMORY_EMBEDDING_PROVIDER = "openai-compatible";
      process.env.AGENT_MEMORY_EMBEDDING_BASE_URL = "https://api.example.com/v1";
      process.env.AGENT_MEMORY_EMBEDDING_API_KEY = "secret";
      process.env.AGENT_MEMORY_EMBEDDING_MODEL = "text-embedding-3-small";
      process.env.AGENT_MEMORY_EMBEDDING_DIMENSION = "2";

      const memory = createMemory(db, { content: "remember this preference", type: "knowledge" })!;
      const row = db.prepare("SELECT status, content_hash FROM embeddings WHERE memory_id = ?").get(memory.id) as { status: string; content_hash: string } | undefined;
      expect(row?.status).toBe("pending");
      expect(row?.content_hash).toBe(memory.hash);
    } finally {
      if (previous.provider === undefined) delete process.env.AGENT_MEMORY_EMBEDDING_PROVIDER;
      else process.env.AGENT_MEMORY_EMBEDDING_PROVIDER = previous.provider;
      if (previous.baseUrl === undefined) delete process.env.AGENT_MEMORY_EMBEDDING_BASE_URL;
      else process.env.AGENT_MEMORY_EMBEDDING_BASE_URL = previous.baseUrl;
      if (previous.apiKey === undefined) delete process.env.AGENT_MEMORY_EMBEDDING_API_KEY;
      else process.env.AGENT_MEMORY_EMBEDDING_API_KEY = previous.apiKey;
      if (previous.model === undefined) delete process.env.AGENT_MEMORY_EMBEDDING_MODEL;
      else process.env.AGENT_MEMORY_EMBEDDING_MODEL = previous.model;
      if (previous.dimension === undefined) delete process.env.AGENT_MEMORY_EMBEDDING_DIMENSION;
      else process.env.AGENT_MEMORY_EMBEDDING_DIMENSION = previous.dimension;
    }
  });

  it("updates and deletes memory", () => {
    const mem = createMemory(db, { content: "old", type: "knowledge" })!;
    const updated = updateMemory(db, mem.id, { content: "new" });
    expect(updated?.content).toBe("new");

    expect(deleteMemory(db, mem.id)).toBe(true);
    expect(getMemory(db, mem.id)).toBeNull();
  });

  it("lists and counts memories", () => {
    createMemory(db, { content: "identity mem", type: "identity" });
    createMemory(db, { content: "event mem", type: "event" });
    createMemory(db, { content: "another event", type: "event" });

    expect(listMemories(db, { type: "event" })).toHaveLength(2);

    const stats = countMemories(db);
    expect(stats.total).toBe(3);
    expect(stats.by_type.identity).toBe(1);
    expect(stats.by_type.event).toBe(2);
    expect(stats.by_priority.P0).toBe(1);
  });

  it("records access and increases stability", () => {
    const mem = createMemory(db, { content: "access test", type: "knowledge" })!;
    const origStability = mem.stability;
    recordAccess(db, mem.id);
    const updated = getMemory(db, mem.id)!;
    expect(updated.access_count).toBe(1);
    expect(updated.stability).toBeGreaterThan(origStability);
  });

  it("creates and resolves URI paths", () => {
    const mem = createMemory(db, { content: "Noah is a succubus", type: "identity" })!;
    const path = createPath(db, mem.id, "core://agent/identity");
    expect(path.uri).toBe("core://agent/identity");

    const resolved = getPathByUri(db, "core://agent/identity");
    expect(resolved?.memory_id).toBe(mem.id);
  });

  it("finds paths by prefix", () => {
    const m1 = createMemory(db, { content: "user name", type: "identity" })!;
    const m2 = createMemory(db, { content: "user pref", type: "knowledge" })!;
    createPath(db, m1.id, "core://user/name");
    createPath(db, m2.id, "core://user/preferences");

    const paths = getPathsByPrefix(db, "core://user/");
    expect(paths).toHaveLength(2);
  });

  it("guard detects duplicates and URI conflicts", async () => {
    createMemory(db, { content: "duplicate test", type: "event" });
    const duplicate = await guard(db, { content: "duplicate test", type: "event" });
    expect(duplicate.action).toBe("skip");

    const mem = createMemory(db, { content: "existing", type: "identity" })!;
    createPath(db, mem.id, "core://agent/name");
    const conflict = await guard(db, { content: "new content", type: "identity", uri: "core://agent/name" });
    expect(conflict.action).toBe("update");
    expect(conflict.existingId).toBe(mem.id);
  });

  it("isolates memories and URI paths between agents", () => {
    const a = createMemory(db, { content: "A user name", type: "identity", agent_id: "agent-a" })!;
    const b = createMemory(db, { content: "B user name", type: "identity", agent_id: "agent-b" })!;

    createPath(db, a.id, "core://user/name");
    createPath(db, b.id, "core://user/name");

    const aPath = getPathByUri(db, "core://user/name", "agent-a");
    const bPath = getPathByUri(db, "core://user/name", "agent-b");
    expect(aPath?.memory_id).toBe(a.id);
    expect(bPath?.memory_id).toBe(b.id);
  });
});
