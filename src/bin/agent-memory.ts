#!/usr/bin/env node
// AgentMemory v2 — CLI
import { openDatabase } from "../core/db.js";
import { createMemory, countMemories, listMemories } from "../core/memory.js";
import { exportMemories } from "../core/export.js";
import { createPath } from "../core/path.js";
import { searchBM25 } from "../search/bm25.js";
import { tokenizeForIndex } from "../search/tokenizer.js";
import { classifyIntent, getStrategy } from "../search/intent.js";
import { rerank } from "../search/rerank.js";
import { boot } from "../sleep/boot.js";
import { runDecay } from "../sleep/decay.js";
import { runTidy } from "../sleep/tidy.js";
import { runGovern } from "../sleep/govern.js";
import { syncOne } from "../sleep/sync.js";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { resolve, basename, join } from "path";
import type { MemoryType } from "../core/memory.js";

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
🧠 AgentMemory v2 — Sleep-cycle memory for AI agents

Usage: agent-memory <command> [options]

Commands:
  init                          Create database
  db:migrate                    Run schema migrations (no-op if up-to-date)
  remember <content> [--uri X] [--type T]  Store a memory
  recall <query> [--limit N]    Search memories
  boot                          Load identity memories
  status                        Show statistics
  reflect [decay|tidy|govern|all]  Run sleep cycle
  reindex                         Rebuild FTS index with jieba tokenizer
  migrate <dir>                 Import from Markdown files
  export <dir>                  Export memories to Markdown files
  help                          Show this help

Environment:
  AGENT_MEMORY_DB      Database path (default: ./agent-memory.db)
  AGENT_MEMORY_AGENT_ID  Agent ID (default: "default")
`);
}

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

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
      const content = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      if (!content) { console.error("Usage: agent-memory remember <content>"); process.exit(1); }
      const db = openDatabase({ path: getDbPath() });
      const uri = getFlag("--uri");
      const type = (getFlag("--type") ?? "knowledge") as MemoryType;
      const result = syncOne(db, { content, type, uri, agent_id: getAgentId() });
      console.log(`${result.action}: ${result.reason}${result.memoryId ? ` (${result.memoryId.slice(0, 8)})` : ""}`);
      db.close();
      break;
    }

    case "recall": {
      const query = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      if (!query) { console.error("Usage: agent-memory recall <query>"); process.exit(1); }
      const db = openDatabase({ path: getDbPath() });
      const limit = parseInt(getFlag("--limit") ?? "10");
      const { intent } = classifyIntent(query);
      const strategy = getStrategy(intent);
      const raw = searchBM25(db, query, { agent_id: getAgentId(), limit: limit * 2 });
      const results = rerank(raw, { ...strategy, limit });

      console.log(`🔍 Intent: ${intent} | Results: ${results.length}\n`);
      for (const r of results) {
        const p = ["🔴", "🟠", "🟡", "⚪"][r.memory.priority];
        const v = (r.memory.vitality * 100).toFixed(0);
        console.log(`${p} P${r.memory.priority} [${v}%] ${r.memory.content.slice(0, 80)}`);
      }
      db.close();
      break;
    }

    case "boot": {
      const db = openDatabase({ path: getDbPath() });
      const result = boot(db, { agent_id: getAgentId() });
      console.log(`🧠 Boot: ${result.identityMemories.length} identity memories loaded\n`);
      for (const m of result.identityMemories) {
        console.log(`  🔴 ${m.content.slice(0, 100)}`);
      }
      if (result.bootPaths.length) {
        console.log(`\n📍 Boot paths: ${result.bootPaths.join(", ")}`);
      }
      db.close();
      break;
    }

    case "status": {
      const db = openDatabase({ path: getDbPath() });
      const agentId = getAgentId();
      const stats = countMemories(db, agentId);
      const lowVit = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE vitality < 0.1 AND agent_id = ?").get(agentId) as { c: number }).c;
      const paths = (db.prepare("SELECT COUNT(*) as c FROM paths WHERE agent_id = ?").get(agentId) as { c: number }).c;
      const links = (db.prepare("SELECT COUNT(*) as c FROM links WHERE agent_id = ?").get(agentId) as { c: number }).c;
      const snaps = (db.prepare(
        `SELECT COUNT(*) as c FROM snapshots s
         JOIN memories m ON m.id = s.memory_id
         WHERE m.agent_id = ?`,
      ).get(agentId) as { c: number }).c;

      console.log("🧠 AgentMemory Status\n");
      console.log(`  Total memories: ${stats.total}`);
      console.log(`  By type: ${Object.entries(stats.by_type).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      console.log(`  By priority: ${Object.entries(stats.by_priority).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      console.log(`  Paths: ${paths} | Links: ${links} | Snapshots: ${snaps}`);
      console.log(`  Low vitality (<10%): ${lowVit}`);
      db.close();
      break;
    }

    case "reflect": {
      const phase = args[1] ?? "all";
      const db = openDatabase({ path: getDbPath() });
      const agentId = getAgentId();
      console.log(`🌙 Running ${phase} phase...\n`);

      if (phase === "decay" || phase === "all") {
        const r = runDecay(db, { agent_id: agentId });
        console.log(`  Decay: ${r.updated} updated, ${r.decayed} decayed, ${r.belowThreshold} below threshold`);
      }
      if (phase === "tidy" || phase === "all") {
        const r = runTidy(db, { agent_id: agentId });
        console.log(`  Tidy: ${r.archived} archived, ${r.orphansCleaned} orphans, ${r.snapshotsPruned} snapshots pruned`);
      }
      if (phase === "govern" || phase === "all") {
        const r = runGovern(db, { agent_id: agentId });
        console.log(`  Govern: ${r.orphanPaths} paths, ${r.orphanLinks} links, ${r.emptyMemories} empty cleaned`);
      }
      db.close();
      break;
    }

    case "reindex": {
      const db = openDatabase({ path: getDbPath() });
      const memories = db.prepare("SELECT id, content FROM memories").all() as Array<{ id: string; content: string }>;
      
      // Clear and rebuild FTS index
      db.exec("DELETE FROM memories_fts");
      const insert = db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)");
      
      let count = 0;
      const txn = db.transaction(() => {
        for (const mem of memories) {
          insert.run(mem.id, tokenizeForIndex(mem.content));
          count++;
        }
      });
      txn();
      
      console.log(`🔄 Reindexed ${count} memories with jieba tokenizer`);
      db.close();
      break;
    }

    case "export": {
      const dir = args[1];
      if (!dir) { console.error("Usage: agent-memory export <directory>"); process.exit(1); }
      const dirPath = resolve(dir);

      const db = openDatabase({ path: getDbPath() });
      const agentId = getAgentId();
      const result = exportMemories(db, dirPath, { agent_id: agentId });
      console.log(`✅ Export complete: ${result.exported} items to ${dirPath} (${result.files.length} files)`);
      db.close();
      break;
    }

    case "migrate": {
      const dir = args[1];
      if (!dir) { console.error("Usage: agent-memory migrate <directory>"); process.exit(1); }
      const dirPath = resolve(dir);
      if (!existsSync(dirPath)) { console.error(`Directory not found: ${dirPath}`); process.exit(1); }

      const db = openDatabase({ path: getDbPath() });
      const agentId = getAgentId();
      let imported = 0;

      // Check for MEMORY.md
      const memoryMd = resolve(dirPath, "MEMORY.md");
      if (existsSync(memoryMd)) {
        const content = readFileSync(memoryMd, "utf-8");
        const sections = content.split(/^## /m).filter((s) => s.trim());

        for (const section of sections) {
          const lines = section.split("\n");
          const title = lines[0]?.trim();
          const body = lines.slice(1).join("\n").trim();
          if (!body) continue;

          const type: MemoryType = title?.toLowerCase().includes("关于") || title?.toLowerCase().includes("about")
            ? "identity" : "knowledge";
          const uri = `knowledge://memory-md/${title?.replace(/[^a-z0-9\u4e00-\u9fff]/gi, "-").toLowerCase()}`;

          syncOne(db, { content: `## ${title}\n${body}`, type, uri, source: "migrate:MEMORY.md", agent_id: agentId });
          imported++;
        }
        console.log(`📄 MEMORY.md: ${sections.length} sections imported`);
      }

      // Check for daily journals
      const mdFiles = readdirSync(dirPath).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
      for (const file of mdFiles) {
        const content = readFileSync(resolve(dirPath, file), "utf-8");
        const date = basename(file, ".md");
        syncOne(db, {
          content,
          type: "event",
          uri: `event://journal/${date}`,
          source: `migrate:${file}`,
          agent_id: agentId,
        });
        imported++;
      }
      if (mdFiles.length) console.log(`📝 Journals: ${mdFiles.length} files imported`);

      // Check for weekly summaries
      const weeklyDir = resolve(dirPath, "weekly");
      if (existsSync(weeklyDir)) {
        const weeklyFiles = readdirSync(weeklyDir).filter((f) => f.endsWith(".md"));
        for (const file of weeklyFiles) {
          const content = readFileSync(resolve(weeklyDir, file), "utf-8");
          const week = basename(file, ".md");
          syncOne(db, {
            content,
            type: "knowledge",
            uri: `knowledge://weekly/${week}`,
            source: `migrate:weekly/${file}`,
            agent_id: agentId,
          });
          imported++;
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
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Error:", message);
  process.exit(1);
}
