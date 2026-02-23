// AgentMemory v3 — Governance cycle (memory health maintenance)
import type Database from "better-sqlite3";

export interface GovernResult {
  orphanPaths: number;
  emptyMemories: number;
}

/**
 * Run governance checks and cleanup:
 * 1. Remove orphan paths (no parent memory)
 * 2. Remove empty memories (blank content)
 */
export function runGovern(db: Database.Database, opts?: { agent_id?: string }): GovernResult {
  const agentId = opts?.agent_id;
  let orphanPaths = 0;
  let emptyMemories = 0;

  const transaction = db.transaction(() => {
    // 1. Orphan paths
    const pathResult = agentId
      ? db.prepare(
        `DELETE FROM paths
         WHERE agent_id = ?
           AND memory_id NOT IN (SELECT id FROM memories WHERE agent_id = ?)`,
      ).run(agentId, agentId)
      : db.prepare("DELETE FROM paths WHERE memory_id NOT IN (SELECT id FROM memories)").run();
    orphanPaths = pathResult.changes;

    // 2. Empty memories
    const emptyResult = agentId
      ? db.prepare("DELETE FROM memories WHERE agent_id = ? AND TRIM(content) = ''").run(agentId)
      : db.prepare("DELETE FROM memories WHERE TRIM(content) = ''").run();
    emptyMemories = emptyResult.changes;
  });

  transaction();

  return { orphanPaths, emptyMemories };
}
