import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../search/embedding.js";
import { openDatabase } from "../core/db.js";
import { rememberMemory } from "../app/remember.js";
import { recallMemory } from "../app/recall.js";
import { surfaceMemories } from "../app/surface.js";
import { reflectMemories } from "../app/reflect.js";
import { getMemoryStatus } from "../app/status.js";
import { recordFeedbackEvent } from "../app/feedback.js";
import { reindexMemories } from "../app/reindex.js";
import type { MemoryType } from "../core/memory.js";
import type { MaintenancePhase } from "../sleep/jobs.js";
import { getMaintenanceJob } from "../sleep/jobs.js";
import type { ReflectRunners } from "../sleep/orchestrator.js";

export interface HttpJobStatus {
  id: string;
  kind: "reflect" | "reindex";
  status: "running" | "completed" | "failed";
  stage: string;
  progress: number;
  agent_id: string;
  started_at: string;
  finished_at: string | null;
  backend_job_id?: string;
  error?: string;
  result?: unknown;
}

export interface HttpServerOptions {
  db?: Database.Database;
  dbPath?: string;
  agentId?: string;
  provider?: EmbeddingProvider | null;
  reflectRunners?: Partial<ReflectRunners>;
}

export interface AgentMemoryHttpServer {
  server: http.Server;
  db: Database.Database;
  jobs: Map<string, HttpJobStatus>;
  listen: (port?: number, host?: string) => Promise<{ port: number; host: string }>;
  close: () => Promise<void>;
}

const VALID_MEMORY_TYPES = new Set<MemoryType>(["identity", "emotion", "knowledge", "event"]);
const VALID_PHASES = new Set<MaintenancePhase>(["decay", "tidy", "govern", "all"]);
const VALID_INTENTS = new Set(["factual", "preference", "temporal", "planning", "design"]);

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function now(): string {
  return new Date().toISOString();
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(json(payload));
}

function sendError(res: ServerResponse, statusCode: number, error: string, details?: unknown): void {
  sendJson(res, statusCode, { error, details });
}

function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
}

function sendSse(res: ServerResponse, event: string, payload: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${json(payload)}\n\n`);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Invalid JSON body");
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return result.length > 0 ? result : [];
}

function wantsSse(req: IncomingMessage, body: Record<string, unknown>): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/event-stream") || body.stream === true;
}

function formatRecallResponse(result: Awaited<ReturnType<typeof recallMemory>>) {
  return {
    mode: result.mode,
    provider_id: result.providerId,
    used_vector_search: result.usedVectorSearch,
    count: result.results.length,
    memories: result.results.map((row) => ({
      id: row.memory.id,
      content: row.memory.content,
      type: row.memory.type,
      priority: row.memory.priority,
      vitality: row.memory.vitality,
      score: row.score,
      bm25_rank: row.bm25_rank,
      vector_rank: row.vector_rank,
      bm25_score: row.bm25_score,
      vector_score: row.vector_score,
      updated_at: row.memory.updated_at,
    })),
  };
}

function formatSurfaceResponse(result: Awaited<ReturnType<typeof surfaceMemories>>) {
  return {
    count: result.count,
    query: result.query,
    task: result.task,
    intent: result.intent,
    results: result.results.map((row) => ({
      id: row.memory.id,
      content: row.memory.content,
      type: row.memory.type,
      priority: row.memory.priority,
      vitality: row.memory.vitality,
      score: row.score,
      semantic_score: row.semantic_score,
      lexical_score: row.lexical_score,
      task_match: row.task_match,
      priority_prior: row.priority_prior,
      feedback_score: row.feedback_score,
      feedback_summary: row.feedback_summary,
      reason_codes: row.reason_codes,
      updated_at: row.memory.updated_at,
    })),
  };
}

function createJob(jobs: Map<string, HttpJobStatus>, kind: HttpJobStatus["kind"], agentId: string): HttpJobStatus {
  const job: HttpJobStatus = {
    id: randomUUID(),
    kind,
    status: "running",
    stage: "queued",
    progress: 0,
    agent_id: agentId,
    started_at: now(),
    finished_at: null,
  };
  jobs.set(job.id, job);
  return job;
}

function updateJob(job: HttpJobStatus, patch: Partial<HttpJobStatus>): HttpJobStatus {
  Object.assign(job, patch);
  return job;
}

export function createHttpServer(options?: HttpServerOptions): AgentMemoryHttpServer {
  const ownsDb = !options?.db;
  const db = options?.db ?? openDatabase({ path: options?.dbPath ?? process.env.AGENT_MEMORY_DB ?? "./agent-memory.db" });
  const defaultAgentId = options?.agentId ?? process.env.AGENT_MEMORY_AGENT_ID ?? "default";
  const jobs = new Map<string, HttpJobStatus>();

  const executeReflectJob = async (
    job: HttpJobStatus,
    body: Record<string, unknown>,
    stream?: ServerResponse,
  ) => {
    const phase = (asString(body.phase) ?? "all") as MaintenancePhase;
    if (!VALID_PHASES.has(phase)) {
      throw new Error(`Invalid phase: ${String(body.phase)}`);
    }

    updateJob(job, { stage: phase, progress: 0.01 });

    try {
      const result = await reflectMemories(db, {
        phase,
        agent_id: asString(body.agent_id) ?? defaultAgentId,
        runners: options?.reflectRunners,
        onProgress: (event) => {
          updateJob(job, {
            stage: String(event.phase),
            progress: event.progress,
            backend_job_id: event.jobId ?? job.backend_job_id,
          });
          if (stream) {
            sendSse(stream, "progress", {
              job,
              event,
            });
          }
        },
      });

      updateJob(job, {
        status: "completed",
        stage: "done",
        progress: 1,
        backend_job_id: result.jobId,
        finished_at: now(),
        result,
      });

      return { job, result };
    } catch (error) {
      updateJob(job, {
        status: "failed",
        stage: "failed",
        progress: 1,
        finished_at: now(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const executeReindexJob = async (
    job: HttpJobStatus,
    body: Record<string, unknown>,
    stream?: ServerResponse,
  ) => {
    updateJob(job, { stage: "fts", progress: 0.01 });

    try {
      const result = await reindexMemories(db, {
        agent_id: asString(body.agent_id) ?? defaultAgentId,
        provider: options?.provider,
        force: asBoolean(body.full) ?? false,
        batchSize: asNumber(body.batch_size) ?? 16,
        onProgress: (event) => {
          updateJob(job, {
            stage: event.stage,
            progress: event.progress,
          });
          if (stream) {
            sendSse(stream, "progress", {
              job,
              event,
            });
          }
        },
      });

      updateJob(job, {
        status: "completed",
        stage: "done",
        progress: 1,
        finished_at: now(),
        result,
      });
      return { job, result };
    } catch (error) {
      updateJob(job, {
        status: "failed",
        stage: "failed",
        progress: 1,
        finished_at: now(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;

      if (method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          service: "agent-memory",
          time: now(),
        });
        return;
      }

      if (method === "GET" && pathname === "/v1/status") {
        const agentId = url.searchParams.get("agent_id") ?? defaultAgentId;
        sendJson(res, 200, getMemoryStatus(db, { agent_id: agentId }));
        return;
      }

      if (method === "GET" && pathname.startsWith("/v1/jobs/")) {
        const id = decodeURIComponent(pathname.slice("/v1/jobs/".length));
        const job = jobs.get(id);
        if (job) {
          sendJson(res, 200, job);
          return;
        }

        const maintenanceJob = getMaintenanceJob(db, id);
        if (maintenanceJob) {
          sendJson(res, 200, maintenanceJob);
          return;
        }

        sendError(res, 404, `Job not found: ${id}`);
        return;
      }

      if (method !== "POST") {
        sendError(res, 404, `Route not found: ${method} ${pathname}`);
        return;
      }

      const body = await readJsonBody(req);

      if (pathname === "/v1/memories") {
        const content = asString(body.content)?.trim();
        if (!content) {
          sendError(res, 400, "content is required");
          return;
        }

        const type = (asString(body.type) ?? "knowledge") as MemoryType;
        if (!VALID_MEMORY_TYPES.has(type)) {
          sendError(res, 400, `Invalid memory type: ${String(body.type)}`);
          return;
        }

        const result = await rememberMemory(db, {
          content,
          type,
          uri: asString(body.uri),
          source: asString(body.source),
          emotion_val: asNumber(body.emotion_val),
          agent_id: asString(body.agent_id) ?? defaultAgentId,
          conservative: asBoolean(body.conservative),
          provider: options?.provider,
        });

        sendJson(res, 200, result);
        return;
      }

      if (pathname === "/v1/recall") {
        const query = asString(body.query)?.trim();
        if (!query) {
          sendError(res, 400, "query is required");
          return;
        }

        const result = await recallMemory(db, {
          query,
          limit: asNumber(body.limit),
          agent_id: asString(body.agent_id) ?? defaultAgentId,
          provider: options?.provider,
        });

        sendJson(res, 200, formatRecallResponse(result));
        return;
      }

      if (pathname === "/v1/surface") {
        const types = asStringArray(body.types)?.filter((type): type is MemoryType => VALID_MEMORY_TYPES.has(type as MemoryType));
        const intent = asString(body.intent);
        if (intent !== undefined && !VALID_INTENTS.has(intent)) {
          sendError(res, 400, `Invalid intent: ${intent}`);
          return;
        }

        const result = await surfaceMemories(db, {
          query: asString(body.query),
          task: asString(body.task),
          recent_turns: asStringArray(body.recent_turns),
          intent: intent as Parameters<typeof surfaceMemories>[1]["intent"],
          types,
          limit: asNumber(body.limit),
          agent_id: asString(body.agent_id) ?? defaultAgentId,
          provider: options?.provider,
        });

        sendJson(res, 200, formatSurfaceResponse(result));
        return;
      }

      if (pathname === "/v1/feedback") {
        const memoryId = asString(body.memory_id)?.trim();
        const source = asString(body.source);
        const useful = asBoolean(body.useful);
        if (!memoryId) {
          sendError(res, 400, "memory_id is required");
          return;
        }
        if (source !== "recall" && source !== "surface") {
          sendError(res, 400, "source must be 'recall' or 'surface'");
          return;
        }
        if (useful === undefined) {
          sendError(res, 400, "useful must be boolean");
          return;
        }

        const result = recordFeedbackEvent(db, {
          memory_id: memoryId,
          source,
          useful,
          agent_id: asString(body.agent_id) ?? defaultAgentId,
        });

        sendJson(res, 200, result);
        return;
      }

      if (pathname === "/v1/reflect") {
        const agentId = asString(body.agent_id) ?? defaultAgentId;
        const job = createJob(jobs, "reflect", agentId);

        if (wantsSse(req, body)) {
          openSse(res);
          sendSse(res, "job", job);
          void executeReflectJob(job, body, res)
            .then(({ job: currentJob, result }) => {
              sendSse(res, "done", { job: currentJob, result });
            })
            .catch((error) => {
              sendSse(res, "error", {
                job,
                error: error instanceof Error ? error.message : String(error),
              });
            })
            .finally(() => {
              if (!res.writableEnded) res.end();
            });
          return;
        }

        const result = await executeReflectJob(job, body);
        sendJson(res, 200, result);
        return;
      }

      if (pathname === "/v1/reindex") {
        const agentId = asString(body.agent_id) ?? defaultAgentId;
        const job = createJob(jobs, "reindex", agentId);

        if (wantsSse(req, body)) {
          openSse(res);
          sendSse(res, "job", job);
          void executeReindexJob(job, body, res)
            .then(({ job: currentJob, result }) => {
              sendSse(res, "done", { job: currentJob, result });
            })
            .catch((error) => {
              sendSse(res, "error", {
                job,
                error: error instanceof Error ? error.message : String(error),
              });
            })
            .finally(() => {
              if (!res.writableEnded) res.end();
            });
          return;
        }

        const result = await executeReindexJob(job, body);
        sendJson(res, 200, result);
        return;
      }

      sendError(res, 404, `Route not found: ${method} ${pathname}`);
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error));
    }
  });

  return {
    server,
    db,
    jobs,
    listen(port = 3000, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            resolve({ port, host });
            return;
          }
          resolve({ port: address.port, host: address.address });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (ownsDb) {
            try { db.close(); } catch {}
          }
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export async function startHttpServer(options?: HttpServerOptions & { port?: number; host?: string }): Promise<AgentMemoryHttpServer> {
  const service = createHttpServer(options);
  await service.listen(options?.port, options?.host);
  return service;
}
