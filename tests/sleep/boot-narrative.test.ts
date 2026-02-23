import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/core/db.js";
import { createMemory, createMemory as createMem } from "../../src/core/memory.js";
import { createPath } from "../../src/core/path.js";
import { boot } from "../../src/sleep/boot.js";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agent-memory-boot-test.db";

describe("Boot compatibility", () => {
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

  it("boot keeps identity loading behavior (json-compatible source)", () => {
    createMemory(db, { content: "I am Noah", type: "identity" });
    const k = createMem(db, { content: "core knowledge", type: "knowledge" })!;
    createPath(db, k.id, "core://agent");

    const result = boot(db);
    expect(result.identityMemories.length).toBeGreaterThan(0);
    expect(result.identityMemories.some((m) => m.type === "identity")).toBe(true);
    expect(result.bootPaths).toContain("core://agent");
  });
});
