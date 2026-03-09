import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type Database from "better-sqlite3";
import { unlinkSync } from "fs";
import { openDatabase } from "../../src/core/db.js";
import { createHttpServer, type AgentMemoryHttpServer } from "../../src/transports/http.js";
import type { EmbeddingProvider } from "../../src/search/embedding.js";

const TEST_DB = "/tmp/agent-memory-http-test.db";

function createStubProvider(vectors: Record<string, number[]>, id = "provider:http-stub"): EmbeddingProvider {
  return {
    id,
    model: "stub",
    dimension: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => vectors[text] ?? [0, 0]);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson<T>(port: number, method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: body === undefined ? undefined : {
        "content-type": "application/json",
      },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw || "null") as T);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function requestSse(port: number, path: string, body?: unknown): Promise<Array<{ event: string; data: unknown }>> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          const events = raw
            .split("\n\n")
            .map((block) => block.trim())
            .filter(Boolean)
            .filter((block) => !block.startsWith(":"))
            .map((block) => {
              const lines = block.split("\n");
              const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
              const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
              return {
                event,
                data: data ? JSON.parse(data) : null,
              };
            });
          resolve(events);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe("HTTP transport", () => {
  let db: Database.Database;
  let service: AgentMemoryHttpServer;
  let port: number;

  beforeEach(async () => {
    [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try { unlinkSync(file); } catch {}
    });

    db = openDatabase({ path: TEST_DB });
    const provider = createStubProvider({
      healthcheck: [0, 0],
      "style rules": [1, 0],
      "UI 设计要克制低饱和，避免玻璃拟态": [1, 0],
    });

    service = createHttpServer({
      db,
      agentId: "http-test",
      provider,
      reflectRunners: {
        decay: async () => {
          await delay(5);
          return { updated: 1, decayed: 1, belowThreshold: 0 };
        },
        tidy: async () => {
          await delay(5);
          return { archived: 0, orphansCleaned: 0 };
        },
        govern: async () => {
          await delay(5);
          return { orphanPaths: 0, emptyMemories: 0, evicted: 0 };
        },
      },
    });

    const address = await service.listen(0, "127.0.0.1");
    port = address.port;
  });

  afterEach(async () => {
    await service.close();
    db.close();
    [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try { unlinkSync(file); } catch {}
    });
  });

  it("serves health/status/remember/recall/surface/feedback and streams reindex/reflect jobs", async () => {
    const health = await requestJson<{ ok: boolean }>(port, "GET", "/health");
    expect(health.ok).toBe(true);

    const remembered = await requestJson<{ action: string; memoryId?: string }>(port, "POST", "/v1/memories", {
      content: "UI 设计要克制低饱和，避免玻璃拟态",
      type: "knowledge",
    });
    expect(remembered.action).toBe("added");
    expect(remembered.memoryId).toBeTruthy();

    const reindexEvents = await requestSse(port, "/v1/reindex", { batch_size: 8 });
    expect(reindexEvents.some((event) => event.event === "progress")).toBe(true);
    const reindexDone = reindexEvents.find((event) => event.event === "done") as {
      event: string;
      data: { job: { status: string }; result: { embeddings: { enabled: boolean; embedded: number } } };
    } | undefined;
    expect(reindexDone?.data.job.status).toBe("completed");
    expect(reindexDone?.data.result.embeddings.enabled).toBe(true);
    expect(reindexDone?.data.result.embeddings.embedded).toBe(1);

    const recall = await requestJson<{ count: number; memories: Array<{ id: string; content: string }> }>(port, "POST", "/v1/recall", {
      query: "玻璃拟态",
      limit: 5,
    });
    expect(recall.count).toBeGreaterThan(0);
    expect(recall.memories[0]?.content).toContain("玻璃拟态");

    const surface = await requestJson<{ count: number; results: Array<{ id: string; reason_codes: string[] }> }>(port, "POST", "/v1/surface", {
      query: "style rules",
      intent: "design",
      limit: 5,
    });
    expect(surface.count).toBeGreaterThan(0);
    expect(surface.results[0]?.reason_codes).toContain("intent:design");

    const feedback = await requestJson<{ source: string; useful: boolean }>(port, "POST", "/v1/feedback", {
      memory_id: remembered.memoryId,
      source: "surface",
      useful: true,
    });
    expect(feedback.source).toBe("surface");
    expect(feedback.useful).toBe(true);

    const status = await requestJson<{ total: number; feedback_events: number }>(port, "GET", "/v1/status");
    expect(status.total).toBe(1);
    expect(status.feedback_events).toBe(1);

    const reflectEvents = await requestSse(port, "/v1/reflect", { phase: "all" });
    expect(reflectEvents.some((event) => event.event === "progress")).toBe(true);
    const reflectJob = reflectEvents.find((event) => event.event === "job") as {
      event: string;
      data: { id: string };
    } | undefined;
    const reflectDone = reflectEvents.find((event) => event.event === "done") as {
      event: string;
      data: { job: { status: string } };
    } | undefined;
    expect(reflectDone?.data.job.status).toBe("completed");

    const jobStatus = await requestJson<{ status: string }>(port, "GET", `/v1/jobs/${reflectJob?.data.id}`);
    expect(jobStatus.status).toBe("completed");
  });
});
