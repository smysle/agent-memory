import type Database from "better-sqlite3";
import { countMemories } from "../core/memory.js";
import { getTieredCapacity } from "../sleep/govern.js";

export interface CapacityInfo {
  count: number;
  limit: number | null;
}

export interface StatusResult {
  total: number;
  by_type: Record<string, number>;
  by_priority: Record<string, number>;
  paths: number;
  low_vitality: number;
  feedback_events: number;
  agent_id: string;
  capacity: Record<string, CapacityInfo>;
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

  const tiered = getTieredCapacity();

  const capacity: Record<string, CapacityInfo> = {
    identity: { count: stats.by_type.identity ?? 0, limit: tiered.identity },
    emotion: { count: stats.by_type.emotion ?? 0, limit: tiered.emotion },
    knowledge: { count: stats.by_type.knowledge ?? 0, limit: tiered.knowledge },
    event: { count: stats.by_type.event ?? 0, limit: tiered.event },
    total: { count: stats.total, limit: tiered.total },
  };

  return {
    ...stats,
    paths: totalPaths.c,
    low_vitality: lowVitality.c,
    feedback_events: feedbackEvents.c,
    agent_id: agentId,
    capacity,
  };
}
