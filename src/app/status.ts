import type Database from "better-sqlite3";
import { countMemories } from "../core/memory.js";

export interface StatusResult {
  total: number;
  by_type: Record<string, number>;
  by_priority: Record<string, number>;
  paths: number;
  low_vitality: number;
  feedback_events: number;
  agent_id: string;
}

export function getMemoryStatus(
  db: Database.Database,
  input?: { agent_id?: string },
): StatusResult {
  const agentId = input?.agent_id ?? "default";
  const stats = countMemories(db, agentId);
  const lowVitality = db.prepare(
    "SELECT COUNT(*) as c FROM memories WHERE vitality < 0.1 AND agent_id = ?",
  ).get(agentId) as { c: number };
  const totalPaths = db.prepare(
    "SELECT COUNT(*) as c FROM paths WHERE agent_id = ?",
  ).get(agentId) as { c: number };
  const feedbackEvents = db.prepare(
    "SELECT COUNT(*) as c FROM feedback_events WHERE agent_id = ?",
  ).get(agentId) as { c: number };

  return {
    ...stats,
    paths: totalPaths.c,
    low_vitality: lowVitality.c,
    feedback_events: feedbackEvents.c,
    agent_id: agentId,
  };
}
