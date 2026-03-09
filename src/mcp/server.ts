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
import { runDecay } from "../sleep/decay.js";
import { runTidy } from "../sleep/tidy.js";
import { runGovern } from "../sleep/govern.js";
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
    ? avgVitalitySource.reduce((s, m) => s + m.vitality, 0) / avgVitalitySource.length
    : 0;

  const lines: string[] = [];

  lines.push("## 🪪 我是谁");
  if (identities.length === 0) {
    lines.push("暂无身份记忆。");
  } else {
    for (const m of identities.slice(0, 6)) {
      lines.push(`- ${m.content.slice(0, 140)}`);
    }
  }

  lines.push("", "## 💕 最近的情感");
  if (emotions.length === 0) {
    lines.push("暂无情感记忆。");
  } else {
    for (const m of emotions.slice(0, 6)) {
      lines.push(`- ${m.content.slice(0, 140)}（vitality: ${m.vitality.toFixed(2)}）`);
    }
  }

  lines.push("", "## 🧠 关键知识");
  if (knowledges.length === 0) {
    lines.push("暂无知识记忆。");
  } else {
    lines.push(`共 ${knowledges.length} 条活跃知识记忆`);
    for (const m of knowledges.slice(0, 8)) {
      lines.push(`- ${m.content.slice(0, 140)}（vitality: ${m.vitality.toFixed(2)}）`);
    }
  }

  lines.push("", "## 📅 近期事件");
  if (recentEvents.length === 0) {
    lines.push("最近 7 天无事件记忆。");
  } else {
    lines.push("最近 7 天内的事件：");
    for (const m of recentEvents.slice(0, 8)) {
      const dateLabel = m.updated_at.slice(5, 10);
      lines.push(`- [${dateLabel}] ${m.content.slice(0, 120)}`);
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

function getMemoryUri(db: ReturnType<typeof openDatabase>, memoryId: string, agentId: string): string {
  const row = db
    .prepare("SELECT uri FROM paths WHERE memory_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(memoryId, agentId) as { uri: string } | undefined;
  return row?.uri ?? "(no-uri)";
}

function formatReflectReport(input: {
  phase: "decay" | "tidy" | "govern" | "all";
  decaySummary?: { updated: number; decayed: number; belowThreshold: number };
  decayDetails?: Array<{ uri: string; type: string; priority: number; oldVitality: number; newVitality: number; content: string }>;
  tidySummary?: { archived: number; orphansCleaned: number };
  archivedDetails?: Array<{ uri: string; content: string; vitality: number; priority: number }>;
  governSummary?: { orphanPaths: number; emptyMemories: number };
  before: { total: number; avgVitality: number };
  after: { total: number; avgVitality: number };
}): string {
  const lines: string[] = [];
  lines.push("## 🌙 Sleep Cycle 报告", "");

  if (input.phase === "decay" || input.phase === "all") {
    const decay = input.decaySummary ?? { updated: 0, decayed: 0, belowThreshold: 0 };
    lines.push("### Decay（衰减）");
    lines.push(`处理 ${decay.updated} 条记忆，其中 ${decay.decayed} 条 vitality 下降。`);

    const details = (input.decayDetails ?? []).slice(0, 8);
    if (details.length > 0) {
      for (const d of details) {
        lines.push(`- ${d.uri} | ${d.type} P${d.priority} | ${d.oldVitality.toFixed(2)} → ${d.newVitality.toFixed(2)} | ${d.content.slice(0, 64)}`);
      }
      if ((input.decayDetails?.length ?? 0) > details.length) {
        lines.push(`- ... 及 ${(input.decayDetails?.length ?? 0) - details.length} 条更多衰减记录`);
      }
    }
    lines.push("");
  }

  if (input.phase === "tidy" || input.phase === "all") {
    const tidy = input.tidySummary ?? { archived: 0, orphansCleaned: 0 };
    lines.push("### Tidy（整理）");
    lines.push(`归档 ${tidy.archived} 条低活力记忆，清理孤儿路径 ${tidy.orphansCleaned} 条。`);

    const archived = (input.archivedDetails ?? []).slice(0, 8);
    if (archived.length > 0) {
      for (const a of archived) {
        lines.push(`- 归档 ${a.uri} | P${a.priority} vitality=${a.vitality.toFixed(2)} | ${a.content.slice(0, 64)}`);
      }
      if ((input.archivedDetails?.length ?? 0) > archived.length) {
        lines.push(`- ... 及 ${(input.archivedDetails?.length ?? 0) - archived.length} 条更多归档记录`);
      }
    }
    lines.push("");
  }

  if (input.phase === "govern" || input.phase === "all") {
    const govern = input.governSummary ?? { orphanPaths: 0, emptyMemories: 0 };
    lines.push("### Govern（治理）");
    lines.push(`孤儿路径：${govern.orphanPaths} 条`);
    lines.push(`空记忆：${govern.emptyMemories} 条`);
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

  // ── Tool 1: remember ──
  server.tool(
    "remember",
    "Store a memory. Runs Write Guard (dedup + conflict detection + 4-criterion gate). Optionally assign a URI path.",
    {
      content: z.string().describe("Memory content to store"),
      type: z.enum(["identity", "emotion", "knowledge", "event"]).default("knowledge").describe("Memory type (determines priority and decay rate)"),
      uri: z.string().optional().describe("URI path (e.g. core://user/name, emotion://2026-02-20/love)"),
      emotion_val: z.number().min(-1).max(1).default(0).describe("Emotional valence (-1 negative to +1 positive)"),
      source: z.string().optional().describe("Source annotation (e.g. session ID, date)"),
    },
    async ({ content, type, uri, emotion_val, source }) => {
      const result = syncOne(db, { content, type, uri, emotion_val, source, agent_id: aid });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── Tool 2: recall ──
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

  // ── Tool 3: recall_path ──
  server.tool(
    "recall_path",
    "Read memory at a specific URI path, or list memories under a URI prefix.",
    {
      uri: z.string().describe("URI path (e.g. core://user/name) or prefix (e.g. core://user/)") ,
      traverse_hops: z.number().default(0).describe("Traversal depth (deprecated, reserved for compatibility)"),
    },
    async ({ uri }) => {
      // Try exact match first
      const path = getPathByUri(db, uri, aid);
      if (path) {
        const mem = getMemory(db, path.memory_id);
        if (mem && mem.agent_id === aid) {
          recordAccess(db, mem.id);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ found: true, memory: mem }, null, 2),
            }],
          };
        }
      }

      // Try prefix search
      const paths = getPathsByPrefix(db, uri, aid);
      if (paths.length > 0) {
        const memories = paths.map((p) => {
          const m = getMemory(db, p.memory_id);
          if (!m || m.agent_id !== aid) return { uri: p.uri, content: undefined, type: undefined, priority: undefined };
          return { uri: p.uri, content: m.content, type: m.type, priority: m.priority, vitality: m.vitality };
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ found: true, prefix: uri, count: paths.length, memories }, null, 2),
          }],
        };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ found: false, uri }, null, 2) }] };
    },
  );

  // ── Tool 4: boot ──
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
        const jsonOutput = {
          count: base.identityMemories.length,
          bootPaths: base.bootPaths,
          memories: base.identityMemories.map((m) => ({
            id: m.id,
            content: m.content,
            type: m.type,
            priority: m.priority,
          })),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(jsonOutput, null, 2) }] };
      }

      const identity = listMemories(db, { agent_id: aid, type: "identity", limit: 12 });
      const emotion = listMemories(db, { agent_id: aid, type: "emotion", min_vitality: 0.1, limit: 12 })
        .sort((a, b) => b.vitality - a.vitality);
      const knowledge = listMemories(db, { agent_id: aid, type: "knowledge", min_vitality: 0.1, limit: 16 })
        .sort((a, b) => b.vitality - a.vitality);
      const event = listMemories(db, { agent_id: aid, type: "event", min_vitality: 0.0, limit: 24 })
        .sort((a, b) => b.vitality - a.vitality);
      const stats = countMemories(db, aid);

      const narrative = formatWarmBootNarrative(identity.length > 0 ? identity : base.identityMemories, emotion, knowledge, event, stats);
      return { content: [{ type: "text" as const, text: narrative }] };
    },
  );

  // ── Tool 5: forget ──
  server.tool(
    "forget",
    "Reduce a memory's vitality (soft forget) or delete it entirely.",
    {
      id: z.string().describe("Memory ID to forget"),
      hard: z.boolean().default(false).describe("Hard delete (true) or soft decay (false)"),
    },
    async ({ id, hard }) => {
      const mem = getMemory(db, id);
      if (!mem || mem.agent_id !== aid) return { content: [{ type: "text" as const, text: '{"error": "Memory not found"}' }] };

      if (hard) {
        const { deleteMemory } = await import("../core/memory.js");
        deleteMemory(db, id);
        return { content: [{ type: "text" as const, text: JSON.stringify({ action: "deleted", id }) }] };
      }

      updateMemory(db, id, { vitality: Math.max(0, mem.vitality * 0.1) });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ action: "decayed", id, new_vitality: mem.vitality * 0.1 }),
        }],
      };
    },
  );

  // ── Tool 6: reflect ──
  server.tool(
    "reflect",
    "Trigger sleep cycle phases and return a human-readable markdown report.",
    {
      phase: z.enum(["decay", "tidy", "govern", "all"]).describe("Which sleep phase to run"),
    },
    async ({ phase }) => {
      const before = getSummaryStats(db, aid);

      let decaySummary: { updated: number; decayed: number; belowThreshold: number } | undefined;
      let tidySummary: { archived: number; orphansCleaned: number } | undefined;
      let governSummary: { orphanPaths: number; emptyMemories: number } | undefined;

      const decayDetails: Array<{ uri: string; type: string; priority: number; oldVitality: number; newVitality: number; content: string }> = [];
      const archivedDetails: Array<{ uri: string; content: string; vitality: number; priority: number }> = [];

      if (phase === "decay" || phase === "all") {
        const beforeRows = db
          .prepare("SELECT id, type, priority, vitality, content FROM memories WHERE agent_id = ?")
          .all(aid) as Array<{ id: string; type: string; priority: number; vitality: number; content: string }>;
        const beforeMap = new Map(beforeRows.map((r) => [r.id, r]));

        decaySummary = runDecay(db, { agent_id: aid });

        const afterRows = db
          .prepare("SELECT id, vitality FROM memories WHERE agent_id = ?")
          .all(aid) as Array<{ id: string; vitality: number }>;

        for (const row of afterRows) {
          const prev = beforeMap.get(row.id);
          if (!prev) continue;
          if (row.vitality < prev.vitality - 0.001) {
            decayDetails.push({
              uri: getMemoryUri(db, row.id, aid),
              type: prev.type,
              priority: prev.priority,
              oldVitality: prev.vitality,
              newVitality: row.vitality,
              content: prev.content,
            });
          }
        }

        decayDetails.sort((a, b) => (b.oldVitality - b.newVitality) - (a.oldVitality - a.newVitality));
      }

      if (phase === "tidy" || phase === "all") {
        const candidates = db
          .prepare("SELECT id, content, vitality, priority FROM memories WHERE agent_id = ? AND vitality < 0.05 AND priority >= 3")
          .all(aid) as Array<{ id: string; content: string; vitality: number; priority: number }>;

        tidySummary = runTidy(db, { agent_id: aid });

        for (const c of candidates) {
          const uriBeforeDelete = getMemoryUri(db, c.id, aid);
          const exists = db.prepare("SELECT id FROM memories WHERE id = ?").get(c.id) as { id: string } | undefined;
          if (!exists) {
            archivedDetails.push({
              uri: uriBeforeDelete,
              content: c.content,
              vitality: c.vitality,
              priority: c.priority,
            });
          }
        }
      }

      if (phase === "govern" || phase === "all") {
        governSummary = runGovern(db, { agent_id: aid });
      }

      const after = getSummaryStats(db, aid);
      const report = formatReflectReport({
        phase,
        decaySummary,
        decayDetails,
        tidySummary,
        archivedDetails,
        governSummary,
        before,
        after,
      });

      return { content: [{ type: "text" as const, text: report }] };
    },
  );

  // ── Tool 7: status ──
  server.tool(
    "status",
    "Get memory system statistics: counts by type/priority and health metrics.",
    {},
    async () => {
      const stats = countMemories(db, aid);
      const lowVitality = db
        .prepare("SELECT COUNT(*) as c FROM memories WHERE vitality < 0.1 AND agent_id = ?")
        .get(aid) as { c: number };
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

  // ── Tool 8: ingest ──
  server.tool(
    "ingest",
    "Extract structured memories from markdown text and write via syncOne().",
    {
      text: z.string().describe("Markdown/plain text to ingest"),
      source: z.string().optional().describe("Source annotation, e.g. memory/2026-02-23.md"),
      dry_run: z.boolean().default(false).optional().describe("Preview extraction without writing"),
    },
    async ({ text, source, dry_run }) => {
      const result = ingestText(db, {
        text,
        source,
        dryRun: dry_run,
        agentId: aid,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // ── Tool 9: reindex ──
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

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // ── Tool 10: surface ──
  server.tool(
    "surface",
    "Lightweight readonly memory surfacing: keyword OR search + priority×vitality×hitRatio ranking (no access recording).",
    {
      keywords: z.array(z.string()).min(1).describe("Keywords to surface related memories"),
      limit: z.number().min(1).max(20).default(5).optional().describe("Max results (default 5, max 20)"),
      types: z.array(z.enum(["identity", "emotion", "knowledge", "event"])) .optional().describe("Optional type filter"),
      min_vitality: z.number().min(0).max(1).default(0.1).optional().describe("Minimum vitality filter"),
    },
    async ({ keywords, limit, types, min_vitality }) => {
      const maxResults = limit ?? 5;
      const minVitality = min_vitality ?? 0.1;
      const normalizedKeywords = keywords.map((k) => k.trim()).filter(Boolean);

      const candidates = new Map<string, { memory: Memory; hits: number }>();

      for (const kw of normalizedKeywords) {
        const results = searchBM25(db, kw, { agent_id: aid, limit: 50, min_vitality: minVitality });
        for (const r of results) {
          const existing = candidates.get(r.memory.id);
          if (existing) {
            existing.hits += 1;
          } else {
            candidates.set(r.memory.id, { memory: r.memory, hits: 1 });
          }
        }
      }

      const scored = [...candidates.values()]
        .filter((c) => c.memory.vitality >= minVitality)
        .filter((c) => (types?.length ? types.includes(c.memory.type) : true))
        .map((c) => {
          const weight = PRIORITY_WEIGHT[c.memory.priority] ?? 1.0;
          const hitRatio = normalizedKeywords.length > 0 ? c.hits / normalizedKeywords.length : 0;
          const score = weight * c.memory.vitality * hitRatio;
          return {
            memory: c.memory,
            hits: c.hits,
            score,
            hitRatio,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      const output = {
        count: scored.length,
        results: scored.map((s) => ({
          id: s.memory.id,
          uri: getMemoryUri(db, s.memory.id, aid),
          type: s.memory.type,
          priority: s.memory.priority,
          vitality: s.memory.vitality,
          content: s.memory.content,
          score: s.score,
          keyword_hits: s.hits,
          updated_at: s.memory.updated_at,
        })),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    },
  );

  return { server, db };
}

// ── Main: run as stdio MCP server ──
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

// Run if executed directly
const isMain = process.argv[1]?.includes("server");
if (isMain) {
  main().catch(console.error);
}
