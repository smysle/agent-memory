// AgentMemory v2 — Association links (knowledge graph)
import type Database from "better-sqlite3";
import { newId, now } from "./db.js";

export type RelationType = "related" | "caused" | "reminds" | "evolved" | "contradicts";

export interface Link {
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
): Link {
  db.prepare(
    `INSERT OR REPLACE INTO links (source_id, target_id, relation, weight, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sourceId, targetId, relation, weight, now());

  return { source_id: sourceId, target_id: targetId, relation, weight, created_at: now() };
}

export function getLinks(db: Database.Database, memoryId: string): Link[] {
  return db
    .prepare("SELECT * FROM links WHERE source_id = ? OR target_id = ?")
    .all(memoryId, memoryId) as Link[];
}

export function getOutgoingLinks(db: Database.Database, sourceId: string): Link[] {
  return db.prepare("SELECT * FROM links WHERE source_id = ?").all(sourceId) as Link[];
}

/**
 * Multi-hop traversal: find all memories reachable within N hops
 * Inspired by PowerMem's knowledge graph traversal
 */
export function traverse(
  db: Database.Database,
  startId: string,
  maxHops = 2,
): Array<{ id: string; hop: number; relation: string }> {
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
        .prepare("SELECT target_id, relation FROM links WHERE source_id = ?")
        .all(current.id) as Array<{ target_id: string; relation: string }>;

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
        .prepare("SELECT source_id, relation FROM links WHERE target_id = ?")
        .all(current.id) as Array<{ source_id: string; relation: string }>;

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
): boolean {
  const result = db
    .prepare("DELETE FROM links WHERE source_id = ? AND target_id = ?")
    .run(sourceId, targetId);
  return result.changes > 0;
}
