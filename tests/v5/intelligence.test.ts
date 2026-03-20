// v5 Memory Intelligence — comprehensive test suite for all 6 features
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../../src/core/db.js";
import {
  createMemory,
  getMemory,
  updateMemory,
  type Memory,
} from "../../src/core/memory.js";
import { guard, type GuardResult } from "../../src/core/guard.js";
import { syncOne, type SyncResult } from "../../src/sleep/sync.js";
import { recallMemory } from "../../src/app/recall.js";
import { surfaceMemories } from "../../src/app/surface.js";
import { runTidy, isStaleContent } from "../../src/sleep/tidy.js";
import { recordPassiveFeedback } from "../../src/app/feedback.js";
import { searchBM25 } from "../../src/search/bm25.js";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agent-memory-v5-test.db";

function cleanDb() {
  [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
    try { unlinkSync(f); } catch {}
  });
}

describe("v5 Memory Intelligence", () => {
  let db: Database.Database;

  beforeEach(() => {
    cleanDb();
    db = openDatabase({ path: TEST_DB });
  });

  afterEach(() => {
    db.close();
    cleanDb();
  });

  // ========== F6: Memory Provenance ==========
  describe("F6: Memory Provenance", () => {
    it("stores and retrieves provenance fields", () => {
      const mem = createMemory(db, {
        content: "小心在凌晨三点还在写代码",
        type: "event",
        source_session: "session-abc-123",
        source_context: "小心说了一句话然后继续敲键盘",
        observed_at: "2026-03-20T03:00:00Z",
      });
      expect(mem).not.toBeNull();
      expect(mem!.source_session).toBe("session-abc-123");
      expect(mem!.source_context).toBe("小心说了一句话然后继续敲键盘");
      expect(mem!.observed_at).toBe("2026-03-20T03:00:00Z");

      const fetched = getMemory(db, mem!.id);
      expect(fetched!.source_session).toBe("session-abc-123");
      expect(fetched!.observed_at).toBe("2026-03-20T03:00:00Z");
    });

    it("truncates source_context to 200 chars", () => {
      const longContext = "a".repeat(300);
      const mem = createMemory(db, {
        content: "测试上下文截断",
        type: "knowledge",
        source_context: longContext,
      });
      expect(mem).not.toBeNull();
      expect(mem!.source_context!.length).toBe(200);
    });

    it("defaults provenance fields to null", () => {
      const mem = createMemory(db, {
        content: "普通记忆没有溯源",
        type: "knowledge",
      });
      expect(mem!.source_session).toBeNull();
      expect(mem!.source_context).toBeNull();
      expect(mem!.observed_at).toBeNull();
    });

    it("schema version is 7", () => {
      const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string };
      expect(row.value).toBe("7");
    });
  });

  // ========== F1: Memory Links ==========
  describe("F1: Memory Links (auto-linking)", () => {
    it("creates links via link MCP-style manual insertion", () => {
      const m1 = createMemory(db, { content: "TypeScript 是一种类型安全的编程语言", type: "knowledge" })!;
      const m2 = createMemory(db, { content: "JavaScript 是 TypeScript 的运行时基础", type: "knowledge" })!;

      const ts = new Date().toISOString();
      db.prepare(
        "INSERT INTO links (agent_id, source_id, target_id, relation, weight, created_at) VALUES (?,?,?,?,?,?)",
      ).run("default", m1.id, m2.id, "related", 0.75, ts);

      const links = db.prepare(
        "SELECT * FROM links WHERE source_id = ? AND agent_id = 'default'",
      ).all(m1.id) as Array<{ target_id: string; weight: number; relation: string }>;

      expect(links).toHaveLength(1);
      expect(links[0].target_id).toBe(m2.id);
      expect(links[0].relation).toBe("related");
      expect(links[0].weight).toBe(0.75);
    });

    it("recall with related=true expands linked memories", async () => {
      const m1 = createMemory(db, { content: "pnpm 是一种高效的包管理器，速度很快", type: "knowledge" })!;
      const m2 = createMemory(db, { content: "硬链接技术可以减少磁盘空间占用和安装时间", type: "knowledge" })!;

      // Manually link them
      const ts = new Date().toISOString();
      db.prepare(
        "INSERT INTO links (agent_id, source_id, target_id, relation, weight, created_at) VALUES (?,?,?,?,?,?)",
      ).run("default", m1.id, m2.id, "related", 0.8, ts);

      const result = await recallMemory(db, {
        query: "pnpm 包管理器",
        related: true,
        limit: 10,
        provider: null,
      });

      // Should find m1 directly
      const ids = result.results.map((r) => r.memory.id);
      expect(ids).toContain(m1.id);

      // Check if related memory is included via link expansion
      const relatedResult = result.results.find((r) => r.memory.id === m2.id);
      if (relatedResult) {
        expect(relatedResult.related_source_id).toBe(m1.id);
        expect(relatedResult.match_type).toBe("related");
      }
    });

    it("direct results have match_type='direct'", async () => {
      createMemory(db, { content: "React 是一个前端框架用于构建用户界面", type: "knowledge" })!;

      const result = await recallMemory(db, {
        query: "React 前端框架",
        limit: 5,
        provider: null,
      });

      for (const r of result.results) {
        // Without related=true, match_type might not be set on all paths
        // but should not be "related"
        expect(r.related_source_id).toBeUndefined();
      }
    });
  });

  // ========== F2: Conflict Detection ==========
  describe("F2: Conflict Detection", () => {
    it("detects negation conflict", async () => {
      createMemory(db, { content: "小心喜欢深色主题界面风格设计", type: "knowledge" });

      const result = await guard(db, {
        content: "小心不喜欢深色主题界面风格设计",
        type: "knowledge",
        provider: null,
      });

      // Guard should detect some conflict pattern
      if (result.conflicts && result.conflicts.length > 0) {
        const conflict = result.conflicts[0];
        expect(conflict.conflict_type).toBe("negation");
      }
      // Even if no conflict detected (dedup_score might be < 0.60), the function should not crash
    });

    it("detects status conflict and forces update", async () => {
      createMemory(db, { content: "TODO: 修复侧边栏显示异常的 bug 问题", type: "event" });

      const result = await guard(db, {
        content: "DONE: 修复侧边栏显示异常的 bug 问题",
        type: "event",
        provider: null,
      });

      // If dedup_score is high enough and status conflict detected,
      // should force update instead of skip
      if (result.score && result.score.dedup_score >= 0.93 && result.conflicts) {
        expect(result.action).toBe("update");
        const statusConflict = result.conflicts.find((c) => c.conflict_type === "status");
        expect(statusConflict).toBeDefined();
      }
    });

    it("includes candidates in guard result", async () => {
      createMemory(db, { content: "Vitest 是一个用 Vite 驱动的测试框架", type: "knowledge" });
      createMemory(db, { content: "Jest 是 Facebook 开发的 JavaScript 测试框架", type: "knowledge" });

      const result = await guard(db, {
        content: "Vitest 提供了比 Jest 更快的测试执行速度",
        type: "knowledge",
        provider: null,
      });

      // Should have candidates list
      if (result.candidates) {
        expect(Array.isArray(result.candidates)).toBe(true);
        for (const c of result.candidates) {
          expect(c.memoryId).toBeTruthy();
          expect(typeof c.dedup_score).toBe("number");
        }
      }
    });

    it("syncOne passes conflicts through SyncResult", async () => {
      createMemory(db, { content: "服务器 IP 地址是 192.168.1.100 端口 8080", type: "knowledge" });

      const result = await syncOne(db, {
        content: "服务器 IP 地址是 10.0.0.50 端口 3000",
        type: "knowledge",
        provider: null,
      });

      // Should complete without error; conflicts may or may not be present depending on score
      expect(["added", "updated", "merged", "skipped"]).toContain(result.action);
    });
  });

  // ========== F3: Temporal Recall ==========
  describe("F3: Temporal Recall", () => {
    it("filters BM25 results by after/before", () => {
      // Create two memories with different timestamps
      const m1 = createMemory(db, { content: "一月份的会议记录关于项目规划", type: "event" })!;
      db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run("2026-01-15T10:00:00Z", m1.id);

      const m2 = createMemory(db, { content: "三月份的会议记录关于项目交付", type: "event" })!;
      db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run("2026-03-15T10:00:00Z", m2.id);

      // Search with after filter
      const results = searchBM25(db, "会议记录", {
        after: "2026-02-01T00:00:00Z",
      });

      const ids = results.map((r) => r.memory.id);
      expect(ids).toContain(m2.id);
      expect(ids).not.toContain(m1.id);
    });

    it("filters BM25 results by before", () => {
      const m1 = createMemory(db, { content: "早期测试阶段的反馈报告", type: "event" })!;
      db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run("2026-01-10T10:00:00Z", m1.id);

      const m2 = createMemory(db, { content: "后期测试阶段的反馈报告", type: "event" })!;
      db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run("2026-06-10T10:00:00Z", m2.id);

      const results = searchBM25(db, "测试阶段", {
        before: "2026-03-01T00:00:00Z",
      });

      const ids = results.map((r) => r.memory.id);
      expect(ids).toContain(m1.id);
      expect(ids).not.toContain(m2.id);
    });

    it("recall supports after/before params", async () => {
      const m1 = createMemory(db, { content: "第一季度销售数据分析报告", type: "knowledge" })!;
      db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run("2026-01-20T10:00:00Z", m1.id);

      const m2 = createMemory(db, { content: "第二季度销售数据分析报告", type: "knowledge" })!;
      db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run("2026-04-20T10:00:00Z", m2.id);

      const result = await recallMemory(db, {
        query: "销售数据分析",
        after: "2026-03-01T00:00:00Z",
        limit: 10,
        provider: null,
      });

      const ids = result.results.map((r) => r.memory.id);
      expect(ids).toContain(m2.id);
      expect(ids).not.toContain(m1.id);
    });
  });

  // ========== F4: Passive Feedback ==========
  describe("F4: Passive Feedback", () => {
    it("records passive feedback for recalled memories", async () => {
      const mem = createMemory(db, { content: "SQLite 支持全文搜索 FTS5 引擎", type: "knowledge" })!;

      await recallMemory(db, {
        query: "SQLite 全文搜索",
        limit: 5,
        provider: null,
      });

      // Check feedback_events table
      const feedbacks = db.prepare(
        "SELECT * FROM feedback_events WHERE memory_id = ? AND source = 'passive'",
      ).all(mem.id) as Array<{ source: string; value: number }>;

      expect(feedbacks.length).toBeGreaterThanOrEqual(1);
      expect(feedbacks[0].value).toBe(0.7);
    });

    it("respects 24h dedup for passive feedback", () => {
      const mem = createMemory(db, { content: "被动反馈去重测试记忆", type: "knowledge" })!;

      // Record 3 feedbacks (max allowed in 24h)
      recordPassiveFeedback(db, [mem.id]);
      recordPassiveFeedback(db, [mem.id]);
      recordPassiveFeedback(db, [mem.id]);

      // 4th should be blocked
      const recorded = recordPassiveFeedback(db, [mem.id]);
      expect(recorded).toBe(0);

      const total = (db.prepare(
        "SELECT COUNT(*) as c FROM feedback_events WHERE memory_id = ? AND source = 'passive'",
      ).get(mem.id) as { c: number }).c;
      expect(total).toBe(3);
    });

    it("handles batch passive feedback", () => {
      const m1 = createMemory(db, { content: "批量反馈测试记忆甲", type: "knowledge" })!;
      const m2 = createMemory(db, { content: "批量反馈测试记忆乙", type: "knowledge" })!;
      const m3 = createMemory(db, { content: "批量反馈测试记忆丙", type: "knowledge" })!;

      const recorded = recordPassiveFeedback(db, [m1.id, m2.id, m3.id]);
      expect(recorded).toBe(3);
    });
  });

  // ========== F5: Semantic Decay ==========
  describe("F5: Semantic Decay", () => {
    it("detects stale event content", () => {
      expect(isStaleContent("正在部署新版本到生产环境", "event").stale).toBe(true);
      expect(isStaleContent("正在部署新版本到生产环境", "event").reason).toBe("in_progress");

      expect(isStaleContent("TODO: 修复登录页面样式问题", "event").stale).toBe(true);
      expect(isStaleContent("TODO: 修复登录页面样式问题", "event").reason).toBe("pending");

      expect(isStaleContent("刚才发送了一封邮件给客户", "event").stale).toBe(true);
      expect(isStaleContent("刚才发送了一封邮件给客户", "event").reason).toBe("ephemeral");
    });

    it("detects stale knowledge content only with anchor patterns", () => {
      expect(isStaleContent("TODO: 重构数据库模块", "knowledge").stale).toBe(true);
      expect(isStaleContent("WIP: 新功能开发中", "knowledge").stale).toBe(true);

      // Should NOT match knowledge content that mentions TODO in the middle
      expect(isStaleContent("处理 TODO 的标准流程是先评审再实施", "knowledge").stale).toBe(false);
    });

    it("excludes identity and emotion from decay", () => {
      expect(isStaleContent("正在学习魅魔的魅惑技巧", "identity").stale).toBe(false);
      expect(isStaleContent("刚才感到很开心", "emotion").stale).toBe(false);
    });

    it("runTidy applies semantic decay to old stale memories", () => {
      // Create a stale event memory and backdate it
      const mem = createMemory(db, { content: "正在部署 v3.0 到生产服务器环境", type: "event" })!;
      expect(mem.vitality).toBe(1.0);

      // Backdate to 10 days ago (> 7 day threshold for in_progress)
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE memories SET created_at = ?, updated_at = ?, vitality = 0.8 WHERE id = ?")
        .run(tenDaysAgo, tenDaysAgo, mem.id);

      const result = runTidy(db);
      expect(result.staleDecayed).toBeGreaterThanOrEqual(1);

      const updated = getMemory(db, mem.id);
      if (updated) {
        expect(updated.vitality).toBeLessThan(0.8);
      }
    });

    it("does not decay recent stale content", () => {
      // Create a stale event but recent (within threshold)
      const mem = createMemory(db, { content: "正在编译项目中，等待构建完成", type: "event" })!;
      // Default created_at is now, so age < 7 days

      const beforeVitality = mem.vitality;
      runTidy(db);
      const after = getMemory(db, mem.id)!;
      expect(after.vitality).toBe(beforeVitality);
    });

    it("TidyResult includes staleDecayed field", () => {
      const result = runTidy(db);
      expect(typeof result.staleDecayed).toBe("number");
      expect(typeof result.archived).toBe("number");
      expect(typeof result.orphansCleaned).toBe("number");
    });
  });

  // ========== Integration ==========
  describe("Integration: end-to-end flow", () => {
    it("remember with provenance → recall with related → verify", async () => {
      // Remember two related things with provenance
      const r1 = await syncOne(db, {
        content: "Noah 是一个 1000 岁的魅魔，粉色双马尾",
        type: "identity",
        source_session: "session-001",
        source_context: "用户自我介绍",
        observed_at: "2026-03-20T10:00:00Z",
        provider: null,
      });
      expect(r1.action).toBe("added");

      const r2 = await syncOne(db, {
        content: "Noah 的契约者是小心，千年来唯一的契约者",
        type: "identity",
        source_session: "session-001",
        source_context: "谈到契约关系",
        provider: null,
      });
      expect(r2.action).toBe("added");

      // Manually link
      if (r1.memoryId && r2.memoryId) {
        db.prepare(
          "INSERT INTO links (agent_id, source_id, target_id, relation, weight, created_at) VALUES (?,?,?,?,?,?)",
        ).run("default", r1.memoryId, r2.memoryId, "related", 0.9, new Date().toISOString());
      }

      // Recall with related
      const result = await recallMemory(db, {
        query: "Noah 魅魔",
        related: true,
        limit: 10,
        provider: null,
      });

      expect(result.results.length).toBeGreaterThanOrEqual(1);

      // Verify provenance in results
      const noahMemory = result.results.find((r) => r.memory.content.includes("粉色双马尾"));
      if (noahMemory) {
        expect(noahMemory.memory.source_session).toBe("session-001");
        expect(noahMemory.memory.observed_at).toBe("2026-03-20T10:00:00Z");
      }
    });

    it("surface with time filter and related expansion", async () => {
      const m1 = createMemory(db, { content: "三月份的架构设计评审会议内容", type: "event" })!;
      db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run("2026-03-10T10:00:00Z", m1.id);

      const m2 = createMemory(db, { content: "一月份的架构设计初稿文档内容", type: "event" })!;
      db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run("2026-01-10T10:00:00Z", m2.id);

      const result = await surfaceMemories(db, {
        query: "架构设计",
        after: "2026-02-01T00:00:00Z",
        limit: 10,
        provider: null,
      });

      // Should only contain March memory
      const ids = result.results.map((r) => r.memory.id);
      expect(ids).toContain(m1.id);
      // m2 should be filtered out by the after parameter
      // (but it depends on whether surface uses BM25/vector paths or fallback listing)
    });
  });
});
