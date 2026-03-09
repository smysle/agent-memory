// AgentMemory v4 — MCP Server (10 tools)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDatabase } from "../core/db.js";
import {
  getMemory,
  updateMemory,
  listMemories,
  countMemories,
  recordAccess,
  type Memory,
} from "../core/memory.js";
import { getPathByUri, getPathsByPrefix } from "../core/path.js";
import { searchBM25 } from "../search/bm25.js";
import { recallMemories, reindexMemorySearch } from "../search/hybrid.js";
import { syncOne } from "../sleep/sync.js";
import { runReflectOrchestrator } from "../sleep/orchestrator.js";
import { boot } from "../sleep/boot.js";
import { ingestText } from "../ingest/ingest.js";
import { runAutoIngestWatcher } from "../ingest/watcher.js";

const DB_PATH = process.env.AGENT_MEMORY_DB ?? "./agent-memory.db";
const AGENT_ID = process.env.AGENT_MEMORY_AGENT_ID ?? "default";

const PRIORITY_WEIGHT: Record<number, number> = {
  0: 4.0,
  1: 3.0,
  2: 2.0,
  3: 1.0,
};

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
  };
}

function formatWarmBootNarrative(
  identities: Memory[],
  emotions: Memory[],
  knowledges: Memory[],
  events: Memory[],
  totalStats: ReturnType<typeof countMemories>,
): string {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const recentEvents = events.filter((e) => new Date(e.updated_at).getTime() >= sevenDaysAgo);
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

export function createMcpServer(dbPath?: string, agentId?: string): { server: McpServer; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase({ path: dbPath ?? DB_PATH });
  const aid = agentId ?? AGENT_ID;

  const server = new McpServer({
    name: "agent-memory",
    version: "4.0.0-alpha.1",
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
    },
    async ({ content, type, uri, emotion_val, source }) => {
      const result = await syncOne(db, { content, type, uri, emotion_val, source, agent_id: aid });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "recall",
    "Search memories using optional hybrid retrieval (BM25 + vector). Falls back to BM25-only when no embedding provider is configured.",
    {
      query: z.string().describe("Search query (natural language)"),
      limit: z.number().default(10).describe("Max results to return"),
    },
    async ({ query, limit }) => {
      const recall = await recallMemories(db, query, { agent_id: aid, limit });
      const output = {
        mode: recall.mode,
        provider_id: recall.providerId,
        count: recall.results.length,
        memories: recall.results.map((result) => ({
          ...formatMemory(result.memory, result.score),
          bm25_rank: result.bm25_rank,
          vector_rank: result.vector_rank,
          bm25_score: result.bm25_score,
          vector_score: result.vector_score,
        })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
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
    },
    async ({ format }) => {
      const outputFormat = format ?? "narrative";
      const base = boot(db, { agent_id: aid });

      if (outputFormat === "json") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: base.identityMemories.length,
              bootPaths: base.bootPaths,
              memories: base.identityMemories.map((memory) => ({
                id: memory.id,
                content: memory.content,
                type: memory.type,
                priority: memory.priority,
              })),
            }, null, 2),
          }],
        };
      }

      const identity = listMemories(db, { agent_id: aid, type: "identity", limit: 12 });
      const emotion = listMemories(db, { agent_id: aid, type: "emotion", min_vitality: 0.1, limit: 12 }).sort((a, b) => b.vitality - a.vitality);
      const knowledge = listMemories(db, { agent_id: aid, type: "knowledge", min_vitality: 0.1, limit: 16 }).sort((a, b) => b.vitality - a.vitality);
      const event = listMemories(db, { agent_id: aid, type: "event", min_vitality: 0.0, limit: 24 }).sort((a, b) => b.vitality - a.vitality);
      const stats = countMemories(db, aid);

      return { content: [{ type: "text" as const, text: formatWarmBootNarrative(identity.length > 0 ? identity : base.identityMemories, emotion, knowledge, event, stats) }] };
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
    },
    async ({ phase }) => {
      const before = getSummaryStats(db, aid);
      const result = await runReflectOrchestrator(db, { phase, agent_id: aid });
      const after = getSummaryStats(db, aid);
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
    {},
    async () => {
      const stats = countMemories(db, aid);
      const lowVitality = db.prepare("SELECT COUNT(*) as c FROM memories WHERE vitality < 0.1 AND agent_id = ?").get(aid) as { c: number };
      const totalPaths = db.prepare("SELECT COUNT(*) as c FROM paths WHERE agent_id = ?").get(aid) as { c: number };
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ...stats,
            paths: totalPaths.c,
            low_vitality: lowVitality.c,
            agent_id: aid,
          }, null, 2),
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
    },
    async ({ full, batch_size }) => {
      const result = await reindexMemorySearch(db, {
        agent_id: aid,
        force: full ?? false,
        batchSize: batch_size ?? 16,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "surface",
    "Lightweight readonly memory surfacing: keyword OR search + priority×vitality×hitRatio ranking (no access recording).",
    {
      keywords: z.array(z.string()).min(1).describe("Keywords to surface related memories"),
      limit: z.number().min(1).max(20).default(5).optional().describe("Max results (default 5, max 20)"),
      types: z.array(z.enum(["identity", "emotion", "knowledge", "event"])).optional().describe("Optional type filter"),
      min_vitality: z.number().min(0).max(1).default(0.1).optional().describe("Minimum vitality filter"),
    },
    async ({ keywords, limit, types, min_vitality }) => {
      const maxResults = limit ?? 5;
      const minVitality = min_vitality ?? 0.1;
      const normalizedKeywords = keywords.map((keyword) => keyword.trim()).filter(Boolean);
      const candidates = new Map<string, { memory: Memory; hits: number }>();

      for (const keyword of normalizedKeywords) {
        const results = searchBM25(db, keyword, { agent_id: aid, limit: 50, min_vitality: minVitality });
        for (const result of results) {
          const existing = candidates.get(result.memory.id);
          if (existing) {
            existing.hits += 1;
          } else {
            candidates.set(result.memory.id, { memory: result.memory, hits: 1 });
          }
        }
      }

      const scored = [...candidates.values()]
        .filter((candidate) => candidate.memory.vitality >= minVitality)
        .filter((candidate) => (types?.length ? types.includes(candidate.memory.type) : true))
        .map((candidate) => {
          const weight = PRIORITY_WEIGHT[candidate.memory.priority] ?? 1.0;
          const hitRatio = normalizedKeywords.length > 0 ? candidate.hits / normalizedKeywords.length : 0;
          return {
            memory: candidate.memory,
            hits: candidate.hits,
            score: weight * candidate.memory.vitality * hitRatio,
          };
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, maxResults);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: scored.length,
            results: scored.map((row) => ({
              id: row.memory.id,
              type: row.memory.type,
              priority: row.memory.priority,
              vitality: row.memory.vitality,
              content: row.memory.content,
              score: row.score,
              keyword_hits: row.hits,
              updated_at: row.memory.updated_at,
            })),
          }, null, 2),
        }],
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
