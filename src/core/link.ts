// AgentMemory v2 — Association links (knowledge graph)
import type Database from "better-sqlite3";
import { now } from "./db.js";

export type RelationType = "related" | "caused" | "reminds" | "evolved" | "contradicts";

export interface Link {
  agent_id: string;
  source_id: string;
  target_id: string;
  relation: RelationType;
  weight: number;
  created_at: string;
}

export function createLink(
  db: Database.Database,
  sourceId: string,
  targetId: string,
  relation: RelationType,
  weight = 1.0,
  agent_id?: string,
): Link {
  const sourceAgent = (db.prepare("SELECT agent_id FROM memories WHERE id = ?").get(sourceId) as { agent_id: string } | undefined)?.agent_id;
  const targetAgent = (db.prepare("SELECT agent_id FROM memories WHERE id = ?").get(targetId) as { agent_id: string } | undefined)?.agent_id;
  if (!sourceAgent) throw new Error(`Source memory not found: ${sourceId}`);
  if (!targetAgent) throw new Error(`Target memory not found: ${targetId}`);
  if (sourceAgent !== targetAgent) throw new Error("Cross-agent links are not allowed");
  if (agent_id && agent_id !== sourceAgent) throw new Error("Agent mismatch for link");
  const agentId = agent_id ?? sourceAgent;

  db.prepare(
    `INSERT OR REPLACE INTO links (agent_id, source_id, target_id, relation, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agentId, sourceId, targetId, relation, weight, now());

  return { agent_id: agentId, source_id: sourceId, target_id: targetId, relation, weight, created_at: now() };
}

export function getLinks(db: Database.Database, memoryId: string, agent_id?: string): Link[] {
  const agentId = agent_id ?? (db.prepare("SELECT agent_id FROM memories WHERE id = ?").get(memoryId) as { agent_id: string } | undefined)?.agent_id ?? "default";
  return db
    .prepare("SELECT * FROM links WHERE agent_id = ? AND (source_id = ? OR target_id = ?)")
    .all(agentId, memoryId, memoryId) as Link[];
}

export function getOutgoingLinks(db: Database.Database, sourceId: string, agent_id?: string): Link[] {
  const agentId = agent_id ?? (db.prepare("SELECT agent_id FROM memories WHERE id = ?").get(sourceId) as { agent_id: string } | undefined)?.agent_id ?? "default";
  return db.prepare("SELECT * FROM links WHERE agent_id = ? AND source_id = ?").all(agentId, sourceId) as Link[];
}

/**
 * Multi-hop traversal: find all memories reachable within N hops
 * Inspired by PowerMem's knowledge graph traversal
 */
export function traverse(
  db: Database.Database,
  startId: string,
  maxHops = 2,
  agent_id?: string,
): Array<{ id: string; hop: number; relation: string }> {
  const agentId = agent_id ?? (db.prepare("SELECT agent_id FROM memories WHERE id = ?").get(startId) as { agent_id: string } | undefined)?.agent_id ?? "default";
  const visited = new Set<string>();
  const results: Array<{ id: string; hop: number; relation: string }> = [];
  const queue: Array<{ id: string; hop: number; relation: string }> = [
    { id: startId, hop: 0, relation: "self" },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    if (current.hop > 0) {
      results.push(current);
    }

    if (current.hop < maxHops) {
      const links = db
        .prepare("SELECT target_id, relation FROM links WHERE agent_id = ? AND source_id = ?")
        .all(agentId, current.id) as Array<{ target_id: string; relation: string }>;

      for (const link of links) {
        if (!visited.has(link.target_id)) {
          queue.push({
            id: link.target_id,
            hop: current.hop + 1,
            relation: link.relation,
          });
        }
      }

      // Also traverse reverse links
      const reverseLinks = db
        .prepare("SELECT source_id, relation FROM links WHERE agent_id = ? AND target_id = ?")
        .all(agentId, current.id) as Array<{ source_id: string; relation: string }>;

      for (const link of reverseLinks) {
        if (!visited.has(link.source_id)) {
          queue.push({
            id: link.source_id,
            hop: current.hop + 1,
            relation: link.relation,
          });
        }
      }
    }
  }

  return results;
}

export function deleteLink(
  db: Database.Database,
  sourceId: string,
  targetId: string,
  agent_id?: string,
): boolean {
  const agentId = agent_id ?? (db.prepare("SELECT agent_id FROM memories WHERE id = ?").get(sourceId) as { agent_id: string } | undefined)?.agent_id ?? "default";
  const result = db
    .prepare("DELETE FROM links WHERE agent_id = ? AND source_id = ? AND target_id = ?")
    .run(agentId, sourceId, targetId);
  return result.changes > 0;
}
