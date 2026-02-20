// AgentMemory v2 — Snapshot system (version control, from nocturne + Memory Palace)
import type Database from "better-sqlite3";
import { newId, now } from "./db.js";
import { tokenizeForIndex } from "../search/tokenizer.js";

export type SnapshotAction = "create" | "update" | "delete" | "merge";

export interface Snapshot {
  id: string;
  memory_id: string;
  content: string;
  changed_by: string | null;
  action: SnapshotAction;
  created_at: string;
}

/**
 * Create a snapshot before modifying a memory.
 * Call this BEFORE any update/delete operation.
 */
export function createSnapshot(
  db: Database.Database,
  memoryId: string,
  action: SnapshotAction,
  changedBy?: string,
): Snapshot {
  const memory = db.prepare("SELECT content FROM memories WHERE id = ?").get(memoryId) as
    | { content: string }
    | undefined;

  if (!memory) throw new Error(`Memory not found: ${memoryId}`);

  const id = newId();
  db.prepare(
    `INSERT INTO snapshots (id, memory_id, content, changed_by, action, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, memoryId, memory.content, changedBy ?? null, action, now());

  return { id, memory_id: memoryId, content: memory.content, changed_by: changedBy ?? null, action, created_at: now() };
}

export function getSnapshots(db: Database.Database, memoryId: string): Snapshot[] {
  return db
    .prepare("SELECT * FROM snapshots WHERE memory_id = ? ORDER BY created_at DESC")
    .all(memoryId) as Snapshot[];
}

export function getSnapshot(db: Database.Database, id: string): Snapshot | null {
  return (db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as Snapshot) ?? null;
}

/**
 * Rollback a memory to a specific snapshot.
 * Creates a new snapshot of the current state before rolling back.
 */
export function rollback(db: Database.Database, snapshotId: string): boolean {
  const snapshot = getSnapshot(db, snapshotId);
  if (!snapshot) return false;

  // Snapshot current state before rollback
  createSnapshot(db, snapshot.memory_id, "update", "rollback");

  // Restore content
  db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?").run(
    snapshot.content,
    now(),
    snapshot.memory_id,
  );

  // Update FTS
  db.prepare("DELETE FROM memories_fts WHERE id = ?").run(snapshot.memory_id);
  db.prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)").run(
    snapshot.memory_id,
    tokenizeForIndex(snapshot.content),
  );

  return true;
}

export function deleteSnapshots(db: Database.Database, memoryId: string): number {
  const result = db.prepare("DELETE FROM snapshots WHERE memory_id = ?").run(memoryId);
  return result.changes;
}
