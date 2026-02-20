// AgentMemory v2 — Governance cycle (memory health maintenance)
import type Database from "better-sqlite3";

export interface GovernResult {
  orphanPaths: number;
  orphanLinks: number;
  emptyMemories: number;
}

/**
 * Run governance checks and cleanup:
 * 1. Remove orphan paths (no parent memory)
 * 2. Remove orphan links (source or target missing)
 * 3. Remove empty memories (blank content)
 */
export function runGovern(db: Database.Database): GovernResult {
  let orphanPaths = 0;
  let orphanLinks = 0;
  let emptyMemories = 0;

  const transaction = db.transaction(() => {
    // 1. Orphan paths
    const pathResult = db
      .prepare("DELETE FROM paths WHERE memory_id NOT IN (SELECT id FROM memories)")
      .run();
    orphanPaths = pathResult.changes;

    // 2. Orphan links
    const linkResult = db
      .prepare(
        `DELETE FROM links WHERE
         source_id NOT IN (SELECT id FROM memories) OR
         target_id NOT IN (SELECT id FROM memories)`,
      )
      .run();
    orphanLinks = linkResult.changes;

    // 3. Empty memories
    const emptyResult = db
      .prepare("DELETE FROM memories WHERE TRIM(content) = ''")
      .run();
    emptyMemories = emptyResult.changes;
  });

  transaction();

  return { orphanPaths, orphanLinks, emptyMemories };
}
