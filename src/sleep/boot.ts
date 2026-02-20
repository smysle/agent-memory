// AgentMemory v2 — Boot loader (system://boot identity loading)
// From nocturne's CORE_MEMORY_URIS concept
import type Database from "better-sqlite3";
import type { Memory } from "../core/memory.js";
import { getPathByUri } from "../core/path.js";
import { getMemory, listMemories, recordAccess } from "../core/memory.js";

export interface BootResult {
  identityMemories: Memory[];
  bootPaths: string[];
}

/**
 * Load core identity memories at startup.
 * Returns all P0 (identity) memories + any memories referenced by system://boot.
 */
export function boot(
  db: Database.Database,
  opts?: { agent_id?: string; corePaths?: string[] },
): BootResult {
  const agentId = opts?.agent_id ?? "default";
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
    recordAccess(db, mem.id, 1.1); // Light access boost on boot
  }

  // 2. Load memories at configured core paths
  const bootPaths: string[] = [];
  for (const uri of corePaths) {
    const path = getPathByUri(db, uri);
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
  const bootEntry = getPathByUri(db, "system://boot");
  if (bootEntry) {
    const bootMem = getMemory(db, bootEntry.memory_id);
    if (bootMem) {
      // system://boot content may list additional URIs (one per line)
      const additionalUris = bootMem.content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.match(/^[a-z]+:\/\//));

      for (const uri of additionalUris) {
        const path = getPathByUri(db, uri);
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

  return {
    identityMemories: [...memories.values()],
    bootPaths,
  };
}
