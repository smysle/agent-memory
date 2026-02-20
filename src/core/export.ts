// AgentMemory v2 — Export memories to Markdown files
import type Database from "better-sqlite3";
import { listMemories, type Memory } from "./memory.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

export interface ExportResult {
  exported: number;
  files: string[];
}

/**
 * Export all memories to Markdown files in the given directory.
 * Creates MEMORY.md for identity/emotion/knowledge and daily .md files for events.
 */
export function exportMemories(
  db: Database.Database,
  dirPath: string,
  opts?: { agent_id?: string },
): ExportResult {
  const agentId = opts?.agent_id ?? "default";
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });

  let exported = 0;
  const files: string[] = [];

  // Export identity, emotion, knowledge as MEMORY.md
  const identities = listMemories(db, { agent_id: agentId, type: "identity" });
  const knowledge = listMemories(db, { agent_id: agentId, type: "knowledge" });
  const emotions = listMemories(db, { agent_id: agentId, type: "emotion" });

  if (identities.length || knowledge.length || emotions.length) {
    const sections: string[] = ["# Agent Memory Export\n"];

    if (identities.length) {
      sections.push("## Identity\n");
      for (const m of identities) {
        sections.push(`- ${m.content}\n`);
        exported++;
      }
    }
    if (emotions.length) {
      sections.push("\n## Emotions\n");
      for (const m of emotions) {
        sections.push(`- ${m.content}\n`);
        exported++;
      }
    }
    if (knowledge.length) {
      sections.push("\n## Knowledge\n");
      for (const m of knowledge) {
        sections.push(`- ${m.content}\n`);
        exported++;
      }
    }

    const memoryPath = join(dirPath, "MEMORY.md");
    writeFileSync(memoryPath, sections.join("\n"));
    files.push(memoryPath);
  }

  // Export events as daily journal files
  const events = listMemories(db, { agent_id: agentId, type: "event", limit: 10000 });
  const byDate = new Map<string, Memory[]>();
  for (const ev of events) {
    const date = ev.created_at.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(ev);
  }

  for (const [date, mems] of byDate) {
    const lines = [`# ${date}\n`];
    for (const m of mems) {
      lines.push(`- ${m.content}\n`);
      exported++;
    }
    const filePath = join(dirPath, `${date}.md`);
    writeFileSync(filePath, lines.join("\n"));
    files.push(filePath);
  }

  return { exported, files };
}
