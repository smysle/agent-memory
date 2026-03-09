// AgentMemory v4.1 — Boot loader with warm boot narrative support
import type Database from "better-sqlite3";
import type { Memory } from "../core/memory.js";
import { getPathByUri } from "../core/path.js";
import { getMemory, listMemories, recordAccess } from "../core/memory.js";

export interface BootResult {
  identityMemories: Memory[];
  bootPaths: string[];
}

export interface WarmBootOptions {
  agent_id?: string;
  corePaths?: string[];
  format?: "json" | "narrative";
  agent_name?: string;
}

export interface WarmBootResult extends BootResult {
  narrative?: string;
  layers?: {
    identity: Memory[];
    emotion: Memory[];
    event: Memory[];
    knowledge: Memory[];
  };
}

/**
 * Format a relative time string from an ISO date.
 */
export function formatRelativeDate(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays <= 7) return `${diffDays}天前`;
  return isoDate.slice(0, 10);
}

/**
 * Load layered memories for warm boot.
 */
export function loadWarmBootLayers(
  db: Database.Database,
  agentId: string,
): { identity: Memory[]; emotion: Memory[]; event: Memory[]; knowledge: Memory[] } {
  const identity = listMemories(db, { agent_id: agentId, type: "identity", limit: 50 });
  const emotion = listMemories(db, { agent_id: agentId, type: "emotion", limit: 5 });
  const event = listMemories(db, { agent_id: agentId, type: "event", limit: 7 });
  const knowledge = listMemories(db, {
    agent_id: agentId,
    type: "knowledge",
    min_vitality: 0.5,
    limit: 10,
  });

  return { identity, emotion, event, knowledge };
}

/**
 * Format layered memories as narrative Markdown.
 */
export function formatNarrativeBoot(
  layers: { identity: Memory[]; emotion: Memory[]; event: Memory[]; knowledge: Memory[] },
  agentName: string,
): string {
  const lines: string[] = [];

  lines.push(`# ${agentName}的回忆`);
  lines.push("");

  // Identity
  if (layers.identity.length > 0) {
    lines.push("## 我是谁");
    for (const mem of layers.identity) {
      lines.push(`- ${mem.content.split("\n")[0].slice(0, 200)}`);
    }
    lines.push("");
  }

  // Emotion
  if (layers.emotion.length > 0) {
    lines.push("## 最近的心情");
    for (const mem of layers.emotion) {
      const tag = (mem as Memory & { emotion_tag?: string }).emotion_tag;
      const time = formatRelativeDate(mem.updated_at);
      const tagStr = tag ? `${tag}, ${time}` : time;
      lines.push(`- ${mem.content.split("\n")[0].slice(0, 200)} (${tagStr})`);
    }
    lines.push("");
  }

  // Events
  if (layers.event.length > 0) {
    lines.push("## 最近发生的事");
    for (const mem of layers.event) {
      const time = formatRelativeDate(mem.updated_at);
      lines.push(`- ${mem.content.split("\n")[0].slice(0, 200)} (${time})`);
    }
    lines.push("");
  }

  // Knowledge
  if (layers.knowledge.length > 0) {
    lines.push("## 还记得的知识");
    for (const mem of layers.knowledge) {
      lines.push(`- ${mem.content.split("\n")[0].slice(0, 200)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Load core identity memories at startup (legacy JSON format).
 * Returns all P0 (identity) memories + any memories referenced by system://boot.
 */
export function boot(
  db: Database.Database,
  opts?: WarmBootOptions,
): WarmBootResult {
  const agentId = opts?.agent_id ?? "default";
  const format = opts?.format ?? "json";
  const agentName = opts?.agent_name ?? "Agent";
  const corePaths = opts?.corePaths ?? [
    "core://agent",
    "core://user",
    "core://agent/identity",
    "core://user/identity",
  ];

  const memories = new Map<string, Memory>();

  // 1. Load all P0 identity memories
  const identities = listMemories(db, { agent_id: agentId, priority: 0 });
  for (const mem of identities) {
    memories.set(mem.id, mem);
    recordAccess(db, mem.id, 1.1);
  }

  // 2. Load memories at configured core paths
  const bootPaths: string[] = [];
  for (const uri of corePaths) {
    const path = getPathByUri(db, uri, agentId);
    if (path) {
      bootPaths.push(uri);
      if (!memories.has(path.memory_id)) {
        const mem = getMemory(db, path.memory_id);
        if (mem) {
          memories.set(mem.id, mem);
          recordAccess(db, mem.id, 1.1);
        }
      }
    }
  }

  // 3. Check system://boot for additional paths
  const bootEntry = getPathByUri(db, "system://boot", agentId);
  if (bootEntry) {
    const bootMem = getMemory(db, bootEntry.memory_id);
    if (bootMem) {
      const additionalUris = bootMem.content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.match(/^[a-z]+:\/\//));

      for (const uri of additionalUris) {
        const path = getPathByUri(db, uri, agentId);
        if (path && !memories.has(path.memory_id)) {
          const mem = getMemory(db, path.memory_id);
          if (mem) {
            memories.set(mem.id, mem);
            bootPaths.push(uri);
          }
        }
      }
    }
  }

  const result: WarmBootResult = {
    identityMemories: [...memories.values()],
    bootPaths,
  };

  // Warm boot: load layered memories and format as narrative
  if (format === "narrative") {
    const layers = loadWarmBootLayers(db, agentId);
    result.layers = layers;
    result.narrative = formatNarrativeBoot(layers, agentName);
  }

  return result;
}
