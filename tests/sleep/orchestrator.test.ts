import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";
import { openDatabase } from "../../src/core/db.js";
import { createMemory, getMemory } from "../../src/core/memory.js";
import { runGovern, rankEvictionCandidates } from "../../src/sleep/govern.js";
import { runReflectOrchestrator } from "../../src/sleep/orchestrator.js";

const TEST_DB = "/tmp/agent-memory-orchestrator-test.db";

describe("reflect orchestrator", () => {
  let db: Database.Database;

  beforeEach(() => {
    [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try { unlinkSync(file); } catch {}
    });
    db = openDatabase({ path: TEST_DB });
  });

  afterEach(() => {
    db.close();
    [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try { unlinkSync(file); } catch {}
    });
  });

  it("runs decay/tidy/govern end-to-end and records a completed job", async () => {
    const memory = createMemory(db, { content: "old event to archive", type: "event" })!;
    db.prepare("UPDATE memories SET created_at = '2024-01-01T00:00:00.000Z' WHERE id = ?").run(memory.id);

    const result = await runReflectOrchestrator(db, { phase: "all" });
    const row = db.prepare("SELECT status, checkpoint FROM maintenance_jobs WHERE job_id = ?").get(result.jobId) as { status: string; checkpoint: string };

    expect(result.job.status).toBe("completed");
    expect(result.checkpoint.completedPhases).toEqual(["decay", "tidy", "govern"]);
    expect(result.results.decay).toBeDefined();
    expect(result.results.tidy).toBeDefined();
    expect(result.results.govern).toBeDefined();
    expect(row.status).toBe("completed");
    expect(JSON.parse(row.checkpoint).nextPhase).toBeNull();
  });

  it("resumes from checkpoint after a phase failure", async () => {
    const calls: Record<string, number> = { decay: 0, tidy: 0, govern: 0 };
    let shouldFailTidy = true;

    await expect(runReflectOrchestrator(db, {
      phase: "all",
      runners: {
        decay: () => {
          calls.decay += 1;
          return { updated: 1, decayed: 1, belowThreshold: 0 };
        },
        tidy: () => {
          calls.tidy += 1;
          if (shouldFailTidy) {
            throw new Error("tidy failed");
          }
          return { archived: 0, orphansCleaned: 0 };
        },
        govern: () => {
          calls.govern += 1;
          return { orphanPaths: 0, emptyMemories: 0, evicted: 0 };
        },
      },
    })).rejects.toThrow("tidy failed");

    const failed = db.prepare("SELECT job_id, status, checkpoint FROM maintenance_jobs ORDER BY started_at DESC LIMIT 1").get() as { job_id: string; status: string; checkpoint: string };
    const checkpoint = JSON.parse(failed.checkpoint) as { completedPhases: string[]; nextPhase: string };
    expect(failed.status).toBe("failed");
    expect(checkpoint.completedPhases).toEqual(["decay"]);
    expect(checkpoint.nextPhase).toBe("tidy");

    shouldFailTidy = false;
    const resumed = await runReflectOrchestrator(db, {
      phase: "all",
      runners: {
        decay: () => {
          calls.decay += 1;
          return { updated: 99 };
        },
        tidy: () => {
          calls.tidy += 1;
          return { archived: 0, orphansCleaned: 0 };
        },
        govern: () => {
          calls.govern += 1;
          return { orphanPaths: 0, emptyMemories: 0, evicted: 0 };
        },
      },
    });

    expect(resumed.resumed).toBe(true);
    expect(resumed.jobId).toBe(failed.job_id);
    expect(resumed.job.status).toBe("completed");
    expect(calls.decay).toBe(1);
    expect(calls.tidy).toBe(2);
    expect(calls.govern).toBe(1);
  });

  it("prioritizes high-redundancy low-value memories for eviction", () => {
    const noisy = createMemory(db, { content: "部署 reflect orchestrator", type: "event" })!;
    const duplicate = createMemory(db, { content: "再次部署 reflect orchestrator", type: "event" })!;
    const valuable = createMemory(db, { content: "Core identity: Alice is the sole contractor", type: "knowledge" })!;

    db.prepare("UPDATE memories SET vitality = 0.15, created_at = '2024-01-01T00:00:00.000Z' WHERE id = ?").run(noisy.id);
    db.prepare("UPDATE memories SET vitality = 0.25, created_at = '2024-02-01T00:00:00.000Z' WHERE id = ?").run(duplicate.id);
    db.prepare("UPDATE memories SET vitality = 0.80, created_at = '2026-03-01T00:00:00.000Z', priority = 2 WHERE id = ?").run(valuable.id);

    const ranked = rankEvictionCandidates(db);
    expect(ranked[0]?.memory.id).toBe(noisy.id);
    expect(ranked[0]?.eviction_score).toBeGreaterThan(ranked[1]?.eviction_score ?? 0);

    const govern = runGovern(db, { maxMemories: 2 });
    expect(govern.evicted).toBe(1);
    expect(getMemory(db, noisy.id)).toBeNull();
    expect(getMemory(db, duplicate.id)).not.toBeNull();
  });
});
