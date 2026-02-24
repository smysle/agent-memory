import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/core/db.js";
import { ingestText } from "../../src/ingest/ingest.js";
import { countMemories, listMemories } from "../../src/core/memory.js";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agent-memory-ingest-test.db";

describe("ingest tool core behavior", () => {
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

  it("dry_run extracts without writing", () => {
    const before = countMemories(db).total;

    const markdown = [
      "## 情感",
      "- 今天很开心",
      "",
      "## 决策",
      "- 记住：发布前要跑测试",
      "",
      "## 事件",
      "- 2026-02-24 完成修复",
    ].join("\n");

    const result = ingestText(db, {
      text: markdown,
      source: "memory/2026-02-24.md",
      dryRun: true,
      agentId: "test-agent",
    });

    expect(result.dry_run).toBe(true);
    expect(result.extracted).toBe(3);
    expect(result.written).toBe(0);

    const after = countMemories(db).total;
    expect(after).toBe(before);
  });

  it("writes extracted memories with auto:source marker", () => {
    const markdown = [
      "## 情感",
      "- 开心到想记录一下",
      "",
      "## 决策",
      "- 规则：先测再发",
      "",
      "## 事件",
      "- 2026-02-24 部署完成",
    ].join("\n");

    const result = ingestText(db, {
      text: markdown,
      source: "memory/2026-02-24.md",
      dryRun: false,
      agentId: "test-agent",
    });

    expect(result.dry_run).toBe(false);
    expect(result.extracted).toBe(3);
    expect(result.written).toBeGreaterThan(0);

    const rows = listMemories(db, { agent_id: "test-agent", limit: 20 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((m) => m.source === "auto:memory/2026-02-24.md")).toBe(true);
  });
});
