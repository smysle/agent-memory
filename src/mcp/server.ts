// AgentMemory v2 — MCP Server (9 tools)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDatabase } from "../core/db.js";
import { createMemory, getMemory, updateMemory, listMemories, countMemories, recordAccess } from "../core/memory.js";
import { createPath, getPathByUri, getPathsByPrefix } from "../core/path.js";
import { createLink, getLinks, traverse } from "../core/link.js";
import { createSnapshot, getSnapshot, getSnapshots, rollback } from "../core/snapshot.js";
import { guard } from "../core/guard.js";
import { classifyIntent, getStrategy } from "../search/intent.js";
import { rerank } from "../search/rerank.js";
import { searchHybrid } from "../search/hybrid.js";
import { getEmbeddingProviderFromEnv } from "../search/providers.js";
import { embedMemory } from "../search/embed.js";
import { syncOne } from "../sleep/sync.js";
import { runDecay } from "../sleep/decay.js";
import { runTidy } from "../sleep/tidy.js";
import { runGovern } from "../sleep/govern.js";
import { boot } from "../sleep/boot.js";

const DB_PATH = process.env.AGENT_MEMORY_DB ?? "./agent-memory.db";
const AGENT_ID = process.env.AGENT_MEMORY_AGENT_ID ?? "default";

export function createMcpServer(dbPath?: string, agentId?: string): { server: McpServer; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase({ path: dbPath ?? DB_PATH });
  const aid = agentId ?? AGENT_ID;
  const embeddingProvider = getEmbeddingProviderFromEnv();

  const server = new McpServer({
    name: "agent-memory",
    version: "2.1.0",
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
      if (embeddingProvider && result.memoryId && (result.action === "added" || result.action === "updated" || result.action === "merged")) {
        try {
          await embedMemory(db, result.memoryId, embeddingProvider, { agent_id: aid });
        } catch {
          // best-effort
        }
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── Tool 2: recall ──
  server.tool(
    "recall",
    "Search memories using intent-aware BM25 search with priority weighting. Automatically classifies query intent (factual/temporal/causal/exploratory).",
    {
      query: z.string().describe("Search query (natural language)"),
      limit: z.number().default(10).describe("Max results to return"),
    },
    async ({ query, limit }) => {
      const { intent, confidence } = classifyIntent(query);
      const strategy = getStrategy(intent);
      const raw = await searchHybrid(db, query, { agent_id: aid, embeddingProvider, limit: limit * 2 });
      const results = rerank(raw, { ...strategy, limit });

      const output = {
        intent,
        confidence,
        count: results.length,
        memories: results.map((r) => ({
          id: r.memory.id,
          content: r.memory.content,
          type: r.memory.type,
          priority: r.memory.priority,
          vitality: r.memory.vitality,
          score: r.score,
          updated_at: r.memory.updated_at,
        })),
      };

      // Record access for returned memories (recall strengthens memory)
      for (const r of results) {
        recordAccess(db, r.memory.id);
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    },
  );

  // ── Tool 3: recall_path ──
  server.tool(
    "recall_path",
    "Read memory at a specific URI path, or list memories under a URI prefix. Supports multi-hop traversal.",
    {
      uri: z.string().describe("URI path (e.g. core://user/name) or prefix (e.g. core://user/)"),
      traverse_hops: z.number().default(0).describe("Multi-hop graph traversal depth (0 = direct only)"),
    },
    async ({ uri, traverse_hops }) => {
      // Try exact match first
      const path = getPathByUri(db, uri, aid);
      if (path) {
        const mem = getMemory(db, path.memory_id);
        if (mem && mem.agent_id === aid) {
          recordAccess(db, mem.id);
          let related: Array<{ id: string; content: string; relation: string; hop: number }> = [];
          if (traverse_hops > 0) {
            const hops = traverse(db, mem.id, traverse_hops, aid);
            related = hops.map((h) => {
              const m = getMemory(db, h.id);
              if (!m || m.agent_id !== aid) return { id: h.id, content: "", relation: h.relation, hop: h.hop };
              return { id: h.id, content: m.content, relation: h.relation, hop: h.hop };
            });
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ found: true, memory: mem, related }, null, 2),
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
          return { uri: p.uri, content: m.content, type: m.type, priority: m.priority };
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
    "Load core identity memories (P0) and system://boot entries. Call this when starting a new session.",
    {},
    async () => {
      const result = boot(db, { agent_id: aid });
      const output = {
        count: result.identityMemories.length,
        bootPaths: result.bootPaths,
        memories: result.identityMemories.map((m) => ({
          id: m.id,
          content: m.content,
          type: m.type,
          priority: m.priority,
        })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
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
        createSnapshot(db, id, "delete", "forget");
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

  // ── Tool 6: link ──
  server.tool(
    "link",
    "Create or query associations between memories (knowledge graph).",
    {
      action: z.enum(["create", "query", "traverse"]).describe("Action to perform"),
      source_id: z.string().optional().describe("Source memory ID"),
      target_id: z.string().optional().describe("Target memory ID (for create)"),
      relation: z.enum(["related", "caused", "reminds", "evolved", "contradicts"]).optional().describe("Relation type"),
      max_hops: z.number().default(2).describe("Max traversal depth (for traverse action)"),
    },
    async ({ action, source_id, target_id, relation, max_hops }) => {
      if (action === "create" && source_id && target_id && relation) {
        const link = createLink(db, source_id, target_id, relation, 1.0, aid);
        return { content: [{ type: "text" as const, text: JSON.stringify({ created: link }) }] };
      }
      if (action === "query" && source_id) {
        const links = getLinks(db, source_id, aid);
        return { content: [{ type: "text" as const, text: JSON.stringify({ links }) }] };
      }
      if (action === "traverse" && source_id) {
        const nodes = traverse(db, source_id, max_hops, aid);
        const detailed = nodes.map((n) => {
          const m = getMemory(db, n.id);
          if (!m || m.agent_id !== aid) return { ...n, content: undefined };
          return { ...n, content: m.content };
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ nodes: detailed }) }] };
      }
      return { content: [{ type: "text" as const, text: '{"error": "Invalid action or missing params"}' }] };
    },
  );

  // ── Tool 7: snapshot ──
  server.tool(
    "snapshot",
    "View or rollback memory snapshots (version history).",
    {
      action: z.enum(["list", "rollback"]).describe("list snapshots or rollback to one"),
      memory_id: z.string().optional().describe("Memory ID (for list)"),
      snapshot_id: z.string().optional().describe("Snapshot ID (for rollback)"),
    },
    async ({ action, memory_id, snapshot_id }) => {
      if (action === "list" && memory_id) {
        const mem = getMemory(db, memory_id);
        if (!mem || mem.agent_id !== aid) return { content: [{ type: "text" as const, text: '{"error": "Memory not found"}' }] };
        const snaps = getSnapshots(db, memory_id);
        return { content: [{ type: "text" as const, text: JSON.stringify({ snapshots: snaps }) }] };
      }
      if (action === "rollback" && snapshot_id) {
        const snap = getSnapshot(db, snapshot_id);
        if (!snap) return { content: [{ type: "text" as const, text: '{"error": "Snapshot not found"}' }] };
        const mem = getMemory(db, snap.memory_id);
        if (!mem || mem.agent_id !== aid) return { content: [{ type: "text" as const, text: '{"error": "Snapshot not found"}' }] };
        const ok = rollback(db, snapshot_id);
        return { content: [{ type: "text" as const, text: JSON.stringify({ rolled_back: ok }) }] };
      }
      return { content: [{ type: "text" as const, text: '{"error": "Invalid action or missing params"}' }] };
    },
  );

  // ── Tool 8: reflect ──
  server.tool(
    "reflect",
    "Trigger sleep cycle phases: decay (Ebbinghaus), tidy (archive + cleanup), or govern (orphan removal).",
    {
      phase: z.enum(["decay", "tidy", "govern", "all"]).describe("Which sleep phase to run"),
    },
    async ({ phase }) => {
      const results: Record<string, unknown> = {};

      if (phase === "decay" || phase === "all") {
        results.decay = runDecay(db, { agent_id: aid });
      }
      if (phase === "tidy" || phase === "all") {
        results.tidy = runTidy(db, { agent_id: aid });
      }
      if (phase === "govern" || phase === "all") {
        results.govern = runGovern(db, { agent_id: aid });
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  // ── Tool 9: status ──
  server.tool(
    "status",
    "Get memory system statistics: counts by type/priority, health metrics.",
    {},
    async () => {
      const stats = countMemories(db, aid);
      const lowVitality = db
        .prepare("SELECT COUNT(*) as c FROM memories WHERE vitality < 0.1 AND agent_id = ?")
        .get(aid) as { c: number };
      const totalSnapshots = db
        .prepare(
          `SELECT COUNT(*) as c
           FROM snapshots s
           JOIN memories m ON m.id = s.memory_id
           WHERE m.agent_id = ?`,
        )
        .get(aid) as { c: number };
      const totalLinks = db.prepare("SELECT COUNT(*) as c FROM links WHERE agent_id = ?").get(aid) as { c: number };
      const totalPaths = db.prepare("SELECT COUNT(*) as c FROM paths WHERE agent_id = ?").get(aid) as { c: number };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ...stats,
            paths: totalPaths.c,
            links: totalLinks.c,
            snapshots: totalSnapshots.c,
            low_vitality: lowVitality.c,
            agent_id: aid,
          }, null, 2),
        }],
      };
    },
  );

  return { server, db };
}

// ── Main: run as stdio MCP server ──
async function main() {
  const { server } = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run if executed directly
const isMain = process.argv[1]?.includes("server");
if (isMain) {
  main().catch(console.error);
}
