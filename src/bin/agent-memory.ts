#!/usr/bin/env node
// AgentMemory — CLI
import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, resolve } from "path";
import { openDatabase } from "../core/db.js";
import { type MemoryType } from "../core/memory.js";
import { exportMemories } from "../core/export.js";
import { boot } from "../sleep/boot.js";
import { surfaceMemories } from "../app/surface.js";
import { startHttpServer } from "../transports/http.js";
import { writeFileSync } from "fs";
import { rememberMemory } from "../app/remember.js";
import { recallMemory } from "../app/recall.js";
import { getMemoryStatus } from "../app/status.js";
import { reflectMemories } from "../app/reflect.js";
import { reindexMemories } from "../app/reindex.js";

const args = process.argv.slice(2);
const command = args[0];

function getDbPath(): string {
  return process.env.AGENT_MEMORY_DB ?? "./agent-memory.db";
}

function getAgentId(): string {
  return process.env.AGENT_MEMORY_AGENT_ID ?? "default";
}

function printHelp() {
  console.log(`
🧠 AgentMemory — Sleep-cycle memory for AI agents

Usage: agent-memory <command> [options]

Commands:
  init                               Create database
  db:migrate                         Run schema migrations (no-op if up-to-date)
  remember <content> [--uri X] [--type T] [--emotion-tag TAG]  Store a memory
  recall <query> [--limit N] [--emotion-tag TAG]  Search memories (hybrid retrieval)
  boot [--format json|narrative] [--agent-name NAME]  Load identity memories
  surface [--out FILE] [--days N] [--limit N]  Export recent memories as Markdown
  status                             Show statistics
  reflect [decay|tidy|govern|all]    Run sleep cycle
  reindex [--full] [--batch-size N]  Rebuild FTS index and embeddings (if configured)
  serve [--host H] [--port N]        Start the HTTP/SSE API server
  migrate <dir>                      Import from Markdown files
  export <dir>                       Export memories to Markdown files
  help                               Show this help

Environment:
  AGENT_MEMORY_DB         Database path (default: ./agent-memory.db)
  AGENT_MEMORY_AGENT_ID   Agent ID (default: "default")
`);
}

function getFlag(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  return undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function getPositionalArgs(startIndex = 1): string[] {
  const values: string[] = [];
  for (let index = startIndex; index < args.length; index++) {
    const token = args[index];
    if (token.startsWith("--")) {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        index += 1;
      }
      continue;
    }
    values.push(token);
  }
  return values;
}

async function main() {
  try {
    switch (command) {
      case "init": {
        const dbPath = getDbPath();
        openDatabase({ path: dbPath });
        console.log(`✅ Database created at ${dbPath}`);
        break;
      }

      case "db:migrate": {
        const dbPath = getDbPath();
        const db = openDatabase({ path: dbPath });
        const version = (db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined)?.value;
        console.log(`✅ Schema version: ${version ?? "unknown"} (${dbPath})`);
        db.close();
        break;
      }

      case "remember": {
        const content = getPositionalArgs(1).join(" ");
        if (!content) {
          console.error("Usage: agent-memory remember <content>");
          process.exit(1);
        }
        const db = openDatabase({ path: getDbPath() });
        const uri = getFlag("--uri");
        const type = (getFlag("--type") ?? "knowledge") as MemoryType;
        const emotionTag = getFlag("--emotion-tag");
        const result = await rememberMemory(db, {
          content,
          type,
          uri,
          source: "manual",
          agent_id: getAgentId(),
          emotion_tag: emotionTag,
        });
        console.log(`${result.action}: ${result.reason}${result.memoryId ? ` (${result.memoryId.slice(0, 8)})` : ""}`);
        db.close();
        break;
      }

      case "recall": {
        const query = getPositionalArgs(1).join(" ");
        if (!query) {
          console.error("Usage: agent-memory recall <query>");
          process.exit(1);
        }
        const db = openDatabase({ path: getDbPath() });
        const emotionTag = getFlag("--emotion-tag");
        const result = await recallMemory(db, {
          query,
          agent_id: getAgentId(),
          limit: Number.parseInt(getFlag("--limit") ?? "10", 10),
          emotion_tag: emotionTag,
        });

        console.log(`🔍 Results: ${result.results.length} (${result.mode})\n`);
        for (const row of result.results) {
          const priorityLabel = ["🔴", "🟠", "🟡", "⚪"][row.memory.priority];
          const vitality = (row.memory.vitality * 100).toFixed(0);
          const branches = [
            row.bm25_rank ? `bm25#${row.bm25_rank}` : null,
            row.vector_rank ? `vec#${row.vector_rank}` : null,
          ].filter(Boolean).join(" + ");
          console.log(`${priorityLabel} P${row.memory.priority} [${vitality}%] ${row.memory.content.slice(0, 80)}${branches ? `  (${branches})` : ""}`);
        }
        db.close();
        break;
      }

      case "boot": {
        const db = openDatabase({ path: getDbPath() });
        const format = (getFlag("--format") ?? "narrative") as "json" | "narrative";
        const agentName = getFlag("--agent-name") ?? "Agent";
        const result = boot(db, { agent_id: getAgentId(), format, agent_name: agentName });
        if (format === "narrative" && result.narrative) {
          console.log(result.narrative);
        } else {
          console.log(`🧠 Boot: ${result.identityMemories.length} identity memories loaded\n`);
          for (const memory of result.identityMemories) {
            console.log(`  🔴 ${memory.content.slice(0, 100)}`);
          }
          if (result.bootPaths.length) {
            console.log(`\n📍 Boot paths: ${result.bootPaths.join(", ")}`);
          }
        }
        db.close();
        break;
      }

      case "surface": {
        const db = openDatabase({ path: getDbPath() });
        const days = Number.parseInt(getFlag("--days") ?? "7", 10);
        const limit = Number.parseInt(getFlag("--limit") ?? "50", 10);
        const minVitality = Number.parseFloat(getFlag("--min-vitality") ?? "0.1");
        const outFile = getFlag("--out");
        const typesRaw = getFlag("--types");
        const types = typesRaw ? typesRaw.split(",").map((t) => t.trim()) as MemoryType[] : undefined;

        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

        const surfaceResult = await surfaceMemories(db, {
          task: "context loading",
          intent: "temporal",
          agent_id: getAgentId(),
          types,
          limit: Math.max(limit, 100), // fetch more, filter by date after
          min_vitality: minVitality,
        });

        // Filter by date window
        const filtered = surfaceResult.results
          .filter((r) => r.memory.updated_at >= cutoff)
          .slice(0, limit);

        // Group by type
        const grouped: Record<string, typeof filtered> = {};
        for (const r of filtered) {
          const t = r.memory.type;
          if (!grouped[t]) grouped[t] = [];
          grouped[t].push(r);
        }

        const { formatRelativeDate } = await import("../sleep/boot.js");
        const lines: string[] = [];
        lines.push("# Recent Memories");
        lines.push("");
        lines.push(`> Auto-generated by AgentMemory surface. Last updated: ${new Date().toISOString()}`);
        lines.push("");

        const typeOrder: MemoryType[] = ["identity", "emotion", "knowledge", "event"];
        const typeLabels: Record<string, string> = { identity: "Identity", emotion: "Emotion", knowledge: "Knowledge", event: "Events" };

        for (const t of typeOrder) {
          const items = grouped[t];
          if (!items?.length) continue;
          lines.push(`## ${typeLabels[t]}`);
          for (const item of items) {
            const content = item.memory.content.split("\n")[0].slice(0, 200);
            const time = formatRelativeDate(item.memory.updated_at);
            const tag = (item.memory as typeof item.memory & { emotion_tag?: string }).emotion_tag;
            const meta = t === "emotion" && tag ? `(${tag}, ${time})` : `(${time})`;
            lines.push(`- ${content} ${meta}`);
          }
          lines.push("");
        }

        const markdown = lines.join("\n");

        if (outFile) {
          writeFileSync(outFile, markdown, "utf-8");
          console.log(`✅ Surface: ${filtered.length} memories written to ${outFile}`);
        } else {
          console.log(markdown);
        }

        db.close();
        break;
      }

      case "status": {
        const db = openDatabase({ path: getDbPath() });
        const status = getMemoryStatus(db, { agent_id: getAgentId() });

        console.log("🧠 AgentMemory Status\n");
        console.log(`  Total memories: ${status.total}`);
        console.log(`  By type: ${Object.entries(status.by_type).map(([key, value]) => `${key}=${value}`).join(", ")}`);
        console.log(`  By priority: ${Object.entries(status.by_priority).map(([key, value]) => `${key}=${value}`).join(", ")}`);
        console.log(`  Paths: ${status.paths}`);
        console.log(`  Low vitality (<10%): ${status.low_vitality}`);
        console.log(`  Feedback events: ${status.feedback_events}`);
        db.close();
        break;
      }

      case "reflect": {
        const phase = (args[1] ?? "all") as "decay" | "tidy" | "govern" | "all";
        const db = openDatabase({ path: getDbPath() });
        const result = await reflectMemories(db, { phase, agent_id: getAgentId() });
        console.log(`🌙 Reflect job ${result.jobId}${result.resumed ? " (resume)" : ""}`);
        for (const [name, summary] of Object.entries(result.results)) {
          console.log(`  ${name}: ${JSON.stringify(summary)}`);
        }
        db.close();
        break;
      }

      case "reindex": {
        const db = openDatabase({ path: getDbPath() });
        const result = await reindexMemories(db, {
          agent_id: getAgentId(),
          force: hasFlag("--full"),
          batchSize: Number.parseInt(getFlag("--batch-size") ?? "16", 10),
        });
        console.log(`🔄 Reindexed ${result.fts.reindexed} memories in BM25 index`);
        if (result.embeddings.enabled) {
          console.log(`🧬 Embeddings: provider=${result.embeddings.providerId} scanned=${result.embeddings.scanned} embedded=${result.embeddings.embedded} failed=${result.embeddings.failed}`);
        } else {
          console.log("🧬 Embeddings: disabled (no provider configured)");
        }
        db.close();
        break;
      }

      case "serve": {
        const port = Number.parseInt(getFlag("--port") ?? process.env.AGENT_MEMORY_HTTP_PORT ?? "3000", 10);
        const host = getFlag("--host") ?? process.env.AGENT_MEMORY_HTTP_HOST ?? "127.0.0.1";
        const service = await startHttpServer({
          dbPath: getDbPath(),
          agentId: getAgentId(),
          port,
          host,
        });
        const address = service.server.address();
        if (address && typeof address !== "string") {
          console.log(`🌐 AgentMemory HTTP server listening on http://${address.address}:${address.port}`);
        } else {
          console.log(`🌐 AgentMemory HTTP server listening on http://${host}:${port}`);
        }

        const shutdown = async () => {
          try {
            await service.close();
          } finally {
            process.exit(0);
          }
        };

        process.once("SIGINT", () => { void shutdown(); });
        process.once("SIGTERM", () => { void shutdown(); });
        break;
      }

      case "export": {
        const dir = args[1];
        if (!dir) {
          console.error("Usage: agent-memory export <directory>");
          process.exit(1);
        }
        const db = openDatabase({ path: getDbPath() });
        const result = exportMemories(db, resolve(dir), { agent_id: getAgentId() });
        console.log(`✅ Export complete: ${result.exported} items to ${resolve(dir)} (${result.files.length} files)`);
        db.close();
        break;
      }

      case "migrate": {
        const dir = args[1];
        if (!dir) {
          console.error("Usage: agent-memory migrate <directory>");
          process.exit(1);
        }
        const dirPath = resolve(dir);
        if (!existsSync(dirPath)) {
          console.error(`Directory not found: ${dirPath}`);
          process.exit(1);
        }

        const db = openDatabase({ path: getDbPath() });
        const agentId = getAgentId();
        let imported = 0;

        const memoryFile = ["MEMORY.md", "MEMORY.qmd"].map((file) => resolve(dirPath, file)).find((file) => existsSync(file));
        if (memoryFile) {
          const content = readFileSync(memoryFile, "utf-8");
          const sections = content.split(/^## /m).filter((section) => section.trim());
          for (const section of sections) {
            const lines = section.split("\n");
            const title = lines[0]?.trim();
            const body = lines.slice(1).join("\n").trim();
            if (!body) continue;
            const type: MemoryType = title?.toLowerCase().includes("关于") || title?.toLowerCase().includes("about") ? "identity" : "knowledge";
            const uri = `knowledge://memory-md/${title?.replace(/[^a-z0-9\u4e00-\u9fff]/gi, "-").toLowerCase()}`;
            await rememberMemory(db, {
              content: `## ${title}\n${body}`,
              type,
              uri,
              source: `migrate:${basename(memoryFile)}`,
              agent_id: agentId,
            });
            imported += 1;
          }
          console.log(`📄 ${basename(memoryFile)}: ${sections.length} sections imported`);
        }

        const mdFiles = readdirSync(dirPath).filter((file) => /^\d{4}-\d{2}-\d{2}\.(md|qmd)$/.test(file)).sort();
        for (const file of mdFiles) {
          const content = readFileSync(resolve(dirPath, file), "utf-8");
          const date = file.replace(/\.(md|qmd)$/i, "");
          await rememberMemory(db, {
            content,
            type: "event",
            uri: `event://journal/${date}`,
            source: `migrate:${file}`,
            agent_id: agentId,
          });
          imported += 1;
        }
        if (mdFiles.length) console.log(`📝 Journals: ${mdFiles.length} files imported`);

        const weeklyDir = resolve(dirPath, "weekly");
        if (existsSync(weeklyDir)) {
          const weeklyFiles = readdirSync(weeklyDir).filter((file) => file.endsWith(".md") || file.endsWith(".qmd"));
          for (const file of weeklyFiles) {
            const content = readFileSync(resolve(weeklyDir, file), "utf-8");
            const week = file.replace(/\.(md|qmd)$/i, "");
            await rememberMemory(db, {
              content,
              type: "knowledge",
              uri: `knowledge://weekly/${week}`,
              source: `migrate:weekly/${file}`,
              agent_id: agentId,
            });
            imported += 1;
          }
          if (weeklyFiles.length) console.log(`📦 Weekly: ${weeklyFiles.length} files imported`);
        }

        console.log(`\n✅ Migration complete: ${imported} items imported`);
        db.close();
        break;
      }

      case "help":
      case "--help":
      case "-h":
      case undefined:
        printHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error:", message);
    process.exit(1);
  }
}

main();
