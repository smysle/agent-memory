// AgentMemory v4 — MCP Server (10 tools)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDatabase, newId, now as dbNow } from "../core/db.js";
import {
  getMemory,
  updateMemory,
  listMemories,
  countMemories,
  recordAccess,
  type Memory,
} from "../core/memory.js";
import { getPathByUri, getPathsByPrefix } from "../core/path.js";
import { boot } from "../sleep/boot.js";
import { ingestText } from "../ingest/ingest.js";
import { runAutoIngestWatcher } from "../ingest/watcher.js";
import { rememberMemory } from "../app/remember.js";
import { recallMemory } from "../app/recall.js";
import { surfaceMemories, type SurfaceIntent } from "../app/surface.js";
import { reflectMemories } from "../app/reflect.js";
import { getMemoryStatus } from "../app/status.js";
import { reindexMemories } from "../app/reindex.js";

const DB_PATH = process.env.AGENT_MEMORY_DB ?? "./agent-memory.db";
const AGENT_ID = process.env.AGENT_MEMORY_AGENT_ID ?? "default";

function formatMemory(memory: Memory, score?: number) {
  return {
    id: memory.id,
    uri: null,
    content: memory.content,
    type: memory.type,
    priority: memory.priority,
    vitality: memory.vitality,
    score,
    updated_at: memory.updated_at,
    source_session: memory.source_session ?? undefined,
    source_context: memory.source_context ?? undefined,
    observed_at: memory.observed_at ?? undefined,
  };
}

function formatWarmBootNarrative(
  identities: Memory[],
  emotions: Memory[],
  knowledges: Memory[],
  events: Memory[],
  totalStats: ReturnType<typeof countMemories>,
): string {
  const currentTime = Date.now();
  const sevenDaysAgo = currentTime - 7 * 24 * 60 * 60 * 1000;
  const recentEvents = events.filter((event) => new Date(event.updated_at).getTime() >= sevenDaysAgo);
  const olderEventCount = Math.max(0, events.length - recentEvents.length);

  const avgVitalitySource = [...identities, ...emotions, ...knowledges, ...events];
  const avgVitality = avgVitalitySource.length
    ? avgVitalitySource.reduce((sum, memory) => sum + memory.vitality, 0) / avgVitalitySource.length
    : 0;

  const lines: string[] = [];
  lines.push("## 🪪 我是谁");
  if (identities.length === 0) {
    lines.push("暂无身份记忆。");
  } else {
    for (const memory of identities.slice(0, 6)) {
      lines.push(`- ${memory.content.slice(0, 140)}`);
    }
  }

  lines.push("", "## 💕 最近的情感");
  if (emotions.length === 0) {
    lines.push("暂无情感记忆。");
  } else {
    for (const memory of emotions.slice(0, 6)) {
      lines.push(`- ${memory.content.slice(0, 140)}（vitality: ${memory.vitality.toFixed(2)}）`);
    }
  }

  lines.push("", "## 🧠 关键知识");
  if (knowledges.length === 0) {
    lines.push("暂无知识记忆。");
  } else {
    lines.push(`共 ${knowledges.length} 条活跃知识记忆`);
    for (const memory of knowledges.slice(0, 8)) {
      lines.push(`- ${memory.content.slice(0, 140)}（vitality: ${memory.vitality.toFixed(2)}）`);
    }
  }

  lines.push("", "## 📅 近期事件");
  if (recentEvents.length === 0) {
    lines.push("最近 7 天无事件记忆。");
  } else {
    lines.push("最近 7 天内的事件：");
    for (const memory of recentEvents.slice(0, 8)) {
      lines.push(`- [${memory.updated_at.slice(5, 10)}] ${memory.content.slice(0, 120)}`);
    }
  }
  if (olderEventCount > 0) {
    lines.push(`- ... 及 ${olderEventCount} 条更早事件`);
  }

  lines.push("", "## 📊 记忆概况");
  lines.push(
    `总计 ${totalStats.total} 条 | identity: ${totalStats.by_type.identity ?? 0} | emotion: ${totalStats.by_type.emotion ?? 0} | knowledge: ${totalStats.by_type.knowledge ?? 0} | event: ${totalStats.by_type.event ?? 0}`,
  );
  lines.push(`平均 vitality: ${avgVitality.toFixed(2)}`);

  return lines.join("\n");
}

function getSummaryStats(db: ReturnType<typeof openDatabase>, agentId: string): { total: number; avgVitality: number } {
  const row = db
    .prepare("SELECT COUNT(*) as total, COALESCE(AVG(vitality), 0) as avg FROM memories WHERE agent_id = ?")
    .get(agentId) as { total: number; avg: number };
  return { total: row.total, avgVitality: row.avg };
}

function formatReflectReport(input: {
  phase: "decay" | "tidy" | "govern" | "all";
  jobId: string;
  resumed: boolean;
  before: { total: number; avgVitality: number };
  after: { total: number; avgVitality: number };
  results: Partial<Record<"decay" | "tidy" | "govern", unknown>>;
}): string {
  const lines: string[] = [];
  lines.push("## 🌙 Sleep Cycle 报告", "");
  lines.push(`job: ${input.jobId}${input.resumed ? "（resume）" : ""}`);
  lines.push(`phase: ${input.phase}`, "");

  for (const phase of ["decay", "tidy", "govern"] as const) {
    if (input.phase !== "all" && input.phase !== phase) continue;
    lines.push(`### ${phase}`);
    lines.push(JSON.stringify(input.results[phase] ?? {}, null, 2));
    lines.push("");
  }

  lines.push("### 📊 总结");
  const delta = input.after.total - input.before.total;
  const deltaLabel = delta > 0 ? `+${delta}` : `${delta}`;
  lines.push(`记忆总数：${input.before.total} → ${input.after.total}（${deltaLabel}）`);
  lines.push(`平均 vitality：${input.before.avgVitality.toFixed(2)} → ${input.after.avgVitality.toFixed(2)}`);
  return lines.join("\n");
}

function formatRecallPayload(result: Awaited<ReturnType<typeof recallMemory>>) {
  return {
    mode: result.mode,
    provider_id: result.providerId,
    count: result.results.length,
    memories: result.results.map((row) => ({
      ...formatMemory(row.memory, row.score),
      bm25_rank: row.bm25_rank,
      vector_rank: row.vector_rank,
      bm25_score: row.bm25_score,
      vector_score: row.vector_score,
      related_source_id: row.related_source_id,
      match_type: row.match_type,
    })),
  };
}

function formatSurfacePayload(result: Awaited<ReturnType<typeof surfaceMemories>>) {
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
      reason_codes: row.reason_codes,
      updated_at: row.memory.updated_at,
      source_session: row.memory.source_session ?? undefined,
      source_context: row.memory.source_context ?? undefined,
      observed_at: row.memory.observed_at ?? undefined,
    })),
  };
}

export function createMcpServer(dbPath?: string, agentId?: string): { server: McpServer; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase({ path: dbPath ?? DB_PATH });
  const aid = agentId ?? AGENT_ID;

  const server = new McpServer({
    name: "agent-memory",
    version: "5.0.0",
  });

  server.tool(
    "remember",
    "Store a memory. Runs Write Guard (semantic dedup + merge policy + four-criterion gate). Optionally assign a URI path.",
    {
      content: z.string().describe("Memory content to store"),
      type: z.enum(["identity", "emotion", "knowledge", "event"]).default("knowledge").describe("Memory type (determines priority and decay rate)"),
      uri: z.string().optional().describe("URI path (e.g. core://user/name, emotion://2026-02-20/love)"),
      emotion_val: z.number().min(-1).max(1).default(0).describe("Emotional valence (-1 negative to +1 positive)"),
      source: z.string().optional().describe("Source annotation (e.g. session ID, date)"),
      agent_id: z.string().optional().describe("Override agent scope (defaults to current agent)"),
      emotion_tag: z.string().optional().describe("Emotion label for emotion-type memories (e.g. 安心, 开心, 担心)"),
      session_id: z.string().optional().describe("Source session ID for provenance tracking"),
      context: z.string().optional().describe("Trigger context for this memory (≤200 chars, auto-truncated)"),
      observed_at: z.string().optional().describe("When the event actually happened (ISO 8601), distinct from write time"),
    },
    async ({ content, type, uri, emotion_val, source, agent_id, emotion_tag, session_id, context, observed_at }) => {
      const result = await rememberMemory(db, {
        content, type, uri, emotion_val, source,
        agent_id: agent_id ?? aid, emotion_tag,
        source_session: session_id,
        source_context: context,
        observed_at,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "recall",
    "Search memories using optional hybrid retrieval (BM25 + vector). Falls back to BM25-only when no embedding provider is configured.",
    {
      query: z.string().describe("Search query (natural language)"),
      limit: z.number().default(10).describe("Max results to return"),
      agent_id: z.string().optional().describe("Override agent scope (defaults to current agent)"),
      emotion_tag: z.string().optional().describe("Filter results by emotion tag (e.g. 安心, 开心)"),
      related: z.boolean().default(false).optional().describe("Expand results with related memories from the links table"),
      after: z.string().optional().describe("Only return memories updated after this ISO 8601 timestamp"),
      before: z.string().optional().describe("Only return memories updated before this ISO 8601 timestamp"),
      recency_boost: z.number().min(0).max(1).default(0).optional().describe("Recency bias (0=none, 1=max). Higher values favor recently updated memories"),
    },
    async ({ query, limit, agent_id, emotion_tag, related, after, before, recency_boost }) => {
      const result = await recallMemory(db, {
        query, limit, agent_id: agent_id ?? aid, emotion_tag,
        related: related ?? false,
        after, before,
        recency_boost: recency_boost ?? 0,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(formatRecallPayload(result), null, 2) }] };
    },
  );

  server.tool(
    "recall_path",
    "Read memory at a specific URI path, or list memories under a URI prefix.",
    {
      uri: z.string().describe("URI path (e.g. core://user/name) or prefix (e.g. core://user/)"),
      traverse_hops: z.number().default(0).describe("Traversal depth (deprecated, reserved for compatibility)"),
    },
    async ({ uri }) => {
      const path = getPathByUri(db, uri, aid);
      if (path) {
        const memory = getMemory(db, path.memory_id);
        if (memory && memory.agent_id === aid) {
          recordAccess(db, memory.id);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ found: true, memory }, null, 2) }],
          };
        }
      }

      const paths = getPathsByPrefix(db, uri, aid);
      if (paths.length > 0) {
        const memories = paths.map((entry) => {
          const memory = getMemory(db, entry.memory_id);
          if (!memory || memory.agent_id !== aid) {
            return { uri: entry.uri, content: undefined, type: undefined, priority: undefined };
          }
          return {
            uri: entry.uri,
            content: memory.content,
            type: memory.type,
            priority: memory.priority,
            vitality: memory.vitality,
          };
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ found: true, prefix: uri, count: paths.length, memories }, null, 2) }],
        };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ found: false, uri }, null, 2) }] };
    },
  );

  server.tool(
    "boot",
    "Load startup memories. Default output is narrative markdown; pass format=json for legacy output.",
    {
      format: z.enum(["narrative", "json"]).default("narrative").optional(),
      agent_name: z.string().optional().describe("Agent name for narrative header (default: Agent)"),
    },
    async ({ format, agent_name }) => {
      const outputFormat = format ?? "narrative";
      const result = boot(db, { agent_id: aid, format: outputFormat, agent_name: agent_name ?? undefined });

      if (outputFormat === "json") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: result.identityMemories.length,
              bootPaths: result.bootPaths,
              memories: result.identityMemories.map((memory) => ({
                id: memory.id,
                content: memory.content,
                type: memory.type,
                priority: memory.priority,
              })),
            }, null, 2),
          }],
        };
      }

      // Use the new warm boot narrative from boot.ts
      if (result.narrative) {
        return { content: [{ type: "text" as const, text: result.narrative }] };
      }

      // Fallback to legacy narrative
      const identity = listMemories(db, { agent_id: aid, type: "identity", limit: 12 });
      const emotion = listMemories(db, { agent_id: aid, type: "emotion", min_vitality: 0.1, limit: 12 }).sort((a, b) => b.vitality - a.vitality);
      const knowledge = listMemories(db, { agent_id: aid, type: "knowledge", min_vitality: 0.1, limit: 16 }).sort((a, b) => b.vitality - a.vitality);
      const event = listMemories(db, { agent_id: aid, type: "event", min_vitality: 0.0, limit: 24 }).sort((a, b) => b.vitality - a.vitality);
      const stats = countMemories(db, aid);

      return { content: [{ type: "text" as const, text: formatWarmBootNarrative(identity.length > 0 ? identity : result.identityMemories, emotion, knowledge, event, stats) }] };
    },
  );

  server.tool(
    "forget",
    "Reduce a memory's vitality (soft forget) or delete it entirely.",
    {
      id: z.string().describe("Memory ID to forget"),
      hard: z.boolean().default(false).describe("Hard delete (true) or soft decay (false)"),
    },
    async ({ id, hard }) => {
      const memory = getMemory(db, id);
      if (!memory || memory.agent_id !== aid) {
        return { content: [{ type: "text" as const, text: '{"error": "Memory not found"}' }] };
      }

      if (hard) {
        const { deleteMemory } = await import("../core/memory.js");
        deleteMemory(db, id);
        return { content: [{ type: "text" as const, text: JSON.stringify({ action: "deleted", id }) }] };
      }

      updateMemory(db, id, { vitality: Math.max(0, memory.vitality * 0.1) });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ action: "decayed", id, new_vitality: memory.vitality * 0.1 }) }],
      };
    },
  );

  server.tool(
    "reflect",
    "Trigger sleep cycle phases via the maintenance orchestrator and return a human-readable markdown report.",
    {
      phase: z.enum(["decay", "tidy", "govern", "all"]).describe("Which sleep phase to run"),
      agent_id: z.string().optional().describe("Override agent scope (defaults to current agent)"),
    },
    async ({ phase, agent_id }) => {
      const effectiveAgentId = agent_id ?? aid;
      const before = getSummaryStats(db, effectiveAgentId);
      const result = await reflectMemories(db, { phase, agent_id: effectiveAgentId });
      const after = getSummaryStats(db, effectiveAgentId);
      const report = formatReflectReport({
        phase,
        jobId: result.jobId,
        resumed: result.resumed,
        before,
        after,
        results: result.results,
      });
      return { content: [{ type: "text" as const, text: report }] };
    },
  );

  server.tool(
    "status",
    "Get memory system statistics: counts by type/priority and health metrics.",
    {
      agent_id: z.string().optional().describe("Override agent scope (defaults to current agent)"),
    },
    async ({ agent_id }) => {
      const stats = getMemoryStatus(db, { agent_id: agent_id ?? aid });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(stats, null, 2),
        }],
      };
    },
  );

  server.tool(
    "ingest",
    "Extract structured memories from markdown text and write via syncOne().",
    {
      text: z.string().describe("Markdown/plain text to ingest"),
      source: z.string().optional().describe("Source annotation, e.g. memory/2026-02-23.md"),
      dry_run: z.boolean().default(false).optional().describe("Preview extraction without writing"),
    },
    async ({ text, source, dry_run }) => {
      const result = await ingestText(db, {
        text,
        source,
        dryRun: dry_run,
        agentId: aid,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "reindex",
    "Rebuild BM25 index and (optionally) embedding vectors for the current agent.",
    {
      full: z.boolean().default(false).optional().describe("Force full embedding rebuild instead of incremental backfill"),
      batch_size: z.number().min(1).max(128).default(16).optional().describe("Embedding batch size for reindex"),
      agent_id: z.string().optional().describe("Override agent scope (defaults to current agent)"),
    },
    async ({ full, batch_size, agent_id }) => {
      const result = await reindexMemories(db, {
        agent_id: agent_id ?? aid,
        force: full ?? false,
        batchSize: batch_size ?? 16,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "surface",
    "Context-aware readonly memory surfacing with query/task/recent_turns/intent scoring (no access recording).",
    {
      query: z.string().optional().describe("Optional semantic query for surfacing"),
      task: z.string().optional().describe("Current task description"),
      recent_turns: z.array(z.string()).optional().describe("Recent conversation turns for context"),
      intent: z.enum(["factual", "preference", "temporal", "planning", "design"]).optional().describe("Surface intent bias"),
      types: z.array(z.enum(["identity", "emotion", "knowledge", "event"]).describe("Optional type filter")).optional(),
      limit: z.number().min(1).max(20).default(5).optional().describe("Max results (default 5, max 20)"),
      agent_id: z.string().optional().describe("Override agent scope (defaults to current agent)"),
      keywords: z.array(z.string()).optional().describe("Deprecated alias: joined into query when query is omitted"),
      related: z.boolean().default(false).optional().describe("Expand results with related memories from the links table"),
      after: z.string().optional().describe("Only return memories updated after this ISO 8601 timestamp"),
      before: z.string().optional().describe("Only return memories updated before this ISO 8601 timestamp"),
      recency_boost: z.number().min(0).max(1).default(0).optional().describe("Recency bias (0=none, 1=max)"),
    },
    async ({ query, task, recent_turns, intent, types, limit, agent_id, keywords, related, after, before, recency_boost }) => {
      const resolvedQuery = query ?? keywords?.join(" ");
      const result = await surfaceMemories(db, {
        query: resolvedQuery,
        task,
        recent_turns,
        intent: intent as SurfaceIntent | undefined,
        types,
        limit: limit ?? 5,
        agent_id: agent_id ?? aid,
        related: related ?? false,
        after,
        before,
        recency_boost: recency_boost ?? 0,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(formatSurfacePayload(result), null, 2),
        }],
      };
    },
  );

  server.tool(
    "link",
    "Manually create or remove an association between two memories.",
    {
      source_id: z.string().describe("Source memory ID"),
      target_id: z.string().describe("Target memory ID"),
      relation: z.enum(["related", "supersedes", "contradicts"]).default("related").describe("Relation type"),
      weight: z.number().min(0).max(1).default(1.0).optional().describe("Link weight (0-1)"),
      remove: z.boolean().default(false).optional().describe("Remove the link instead of creating it"),
      agent_id: z.string().optional().describe("Override agent scope (defaults to current agent)"),
    },
    async ({ source_id, target_id, relation, weight, remove, agent_id }) => {
      const effectiveAgentId = agent_id ?? aid;

      if (remove) {
        const result = db.prepare(
          "DELETE FROM links WHERE agent_id = ? AND source_id = ? AND target_id = ?",
        ).run(effectiveAgentId, source_id, target_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ action: "removed", changes: result.changes }) }],
        };
      }

      const timestamp = dbNow();
      db.prepare(
        `INSERT OR REPLACE INTO links (agent_id, source_id, target_id, relation, weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(effectiveAgentId, source_id, target_id, relation, weight ?? 1.0, timestamp);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          action: "created",
          source_id,
          target_id,
          relation,
          weight: weight ?? 1.0,
        }) }],
      };
    },
  );

  return { server, db };
}

async function main() {
  const { server, db } = createMcpServer();
  const transport = new StdioServerTransport();

  const autoIngestEnabled = process.env.AGENT_MEMORY_AUTO_INGEST !== "0";
  const workspaceDir = process.env.AGENT_MEMORY_WORKSPACE ?? `${process.env.HOME ?? "."}/.openclaw/workspace`;
  const agentId = process.env.AGENT_MEMORY_AGENT_ID ?? "default";
  const watcher = autoIngestEnabled
    ? runAutoIngestWatcher({
      db,
      workspaceDir,
      agentId,
    })
    : null;

  const shutdown = () => {
    try { watcher?.close(); } catch {}
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("exit", shutdown);

  await server.connect(transport);
}

const isMain = process.argv[1]?.includes("server");
if (isMain) {
  main().catch(console.error);
}
