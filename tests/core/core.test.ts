import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/core/db.js";
import { createMemory, getMemory, updateMemory, deleteMemory, listMemories, recordAccess, countMemories } from "../../src/core/memory.js";
import { createPath, getPathByUri, getPathsByMemory, getPathsByPrefix } from "../../src/core/path.js";
import { createLink, getLinks, traverse } from "../../src/core/link.js";
import { createSnapshot, getSnapshots, rollback } from "../../src/core/snapshot.js";
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

  // ── Memory CRUD ──

  it("creates and retrieves a memory", () => {
    const mem = createMemory(db, { content: "小心是我的契约者", type: "identity" });
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe("小心是我的契约者");
    expect(mem!.type).toBe("identity");
    expect(mem!.priority).toBe(0); // identity → P0

    const fetched = getMemory(db, mem!.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe("小心是我的契约者");
  });

  it("deduplicates identical content", () => {
    const m1 = createMemory(db, { content: "test dedup", type: "event" });
    const m2 = createMemory(db, { content: "test dedup", type: "event" });
    expect(m1).not.toBeNull();
    expect(m2).toBeNull(); // duplicate → skipped
  });

  it("updates a memory", () => {
    const mem = createMemory(db, { content: "old content", type: "knowledge" })!;
    const updated = updateMemory(db, mem.id, { content: "new content" });
    expect(updated!.content).toBe("new content");
  });

  it("deletes a memory", () => {
    const mem = createMemory(db, { content: "to delete", type: "event" })!;
    expect(deleteMemory(db, mem.id)).toBe(true);
    expect(getMemory(db, mem.id)).toBeNull();
  });

  it("lists memories with filters", () => {
    createMemory(db, { content: "identity mem", type: "identity" });
    createMemory(db, { content: "event mem", type: "event" });
    createMemory(db, { content: "another event", type: "event" });

    const events = listMemories(db, { type: "event" });
    expect(events).toHaveLength(2);

    const identities = listMemories(db, { type: "identity" });
    expect(identities).toHaveLength(1);
  });

  it("records access and increases stability", () => {
    const mem = createMemory(db, { content: "access test", type: "knowledge" })!;
    const origStability = mem.stability;
    recordAccess(db, mem.id);
    const updated = getMemory(db, mem.id)!;
    expect(updated.access_count).toBe(1);
    expect(updated.stability).toBeGreaterThan(origStability);
  });

  it("counts memories by type and priority", () => {
    createMemory(db, { content: "id1", type: "identity" });
    createMemory(db, { content: "em1", type: "emotion" });
    createMemory(db, { content: "ev1", type: "event" });
    createMemory(db, { content: "ev2", type: "event" });

    const stats = countMemories(db);
    expect(stats.total).toBe(4);
    expect(stats.by_type.identity).toBe(1);
    expect(stats.by_type.event).toBe(2);
    expect(stats.by_priority.P0).toBe(1);
  });

  // ── URI Paths ──

  it("creates and resolves URI paths", () => {
    const mem = createMemory(db, { content: "Noah is a succubus", type: "identity" })!;
    const path = createPath(db, mem.id, "core://agent/identity");
    expect(path.uri).toBe("core://agent/identity");
    expect(path.domain).toBe("core");

    const resolved = getPathByUri(db, "core://agent/identity");
    expect(resolved).not.toBeNull();
    expect(resolved!.memory_id).toBe(mem.id);
  });

  it("finds paths by prefix", () => {
    const m1 = createMemory(db, { content: "user name", type: "identity" })!;
    const m2 = createMemory(db, { content: "user pref", type: "knowledge" })!;
    createPath(db, m1.id, "core://user/name");
    createPath(db, m2.id, "core://user/preferences");

    const paths = getPathsByPrefix(db, "core://user/");
    expect(paths).toHaveLength(2);
  });

  it("rejects invalid domain", () => {
    const mem = createMemory(db, { content: "test", type: "event" })!;
    expect(() => createPath(db, mem.id, "invalid://test")).toThrow("Invalid domain");
  });

  // ── Links (Knowledge Graph) ──

  it("creates links and traverses", () => {
    const m1 = createMemory(db, { content: "node A", type: "knowledge" })!;
    const m2 = createMemory(db, { content: "node B", type: "knowledge" })!;
    const m3 = createMemory(db, { content: "node C", type: "knowledge" })!;

    createLink(db, m1.id, m2.id, "related");
    createLink(db, m2.id, m3.id, "caused");

    // Direct links
    const links = getLinks(db, m1.id);
    expect(links).toHaveLength(1);

    // Multi-hop: A → B → C
    const reachable = traverse(db, m1.id, 2);
    expect(reachable).toHaveLength(2);
    expect(reachable.some((r) => r.id === m3.id)).toBe(true);
  });

  // ── Snapshots ──

  it("creates snapshots and rolls back", () => {
    const mem = createMemory(db, { content: "original", type: "knowledge" })!;
    createSnapshot(db, mem.id, "update", "test");
    updateMemory(db, mem.id, { content: "modified" });

    const snapshots = getSnapshots(db, mem.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].content).toBe("original");

    // Rollback
    rollback(db, snapshots[0].id);
    const restored = getMemory(db, mem.id)!;
    expect(restored.content).toBe("original");
  });

  // ── Write Guard ──

  it("guard detects exact duplicates", () => {
    createMemory(db, { content: "duplicate test", type: "event" });
    const result = guard(db, { content: "duplicate test", type: "event" });
    expect(result.action).toBe("skip");
  });

  it("guard detects URI conflicts", () => {
    const mem = createMemory(db, { content: "existing", type: "identity" })!;
    createPath(db, mem.id, "core://agent/name");
    const result = guard(db, { content: "new content", type: "identity", uri: "core://agent/name" });
    expect(result.action).toBe("update");
    expect(result.existingId).toBe(mem.id);
  });

  it("guard allows new content", () => {
    const result = guard(db, { content: "completely new thing", type: "knowledge" });
    expect(result.action).toBe("add");
  });

  // ── Agent Isolation ──

  it("isolates memories between agents", () => {
    createMemory(db, { content: "agent A memory", type: "event", agent_id: "agent-a" });
    createMemory(db, { content: "agent B memory", type: "event", agent_id: "agent-b" });

    const aMemories = listMemories(db, { agent_id: "agent-a" });
    const bMemories = listMemories(db, { agent_id: "agent-b" });
    expect(aMemories).toHaveLength(1);
    expect(bMemories).toHaveLength(1);
    expect(aMemories[0].content).toBe("agent A memory");
    expect(bMemories[0].content).toBe("agent B memory");
  });

  it("isolates URI paths between agents", () => {
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
