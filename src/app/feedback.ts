import type Database from "better-sqlite3";
import { newId, now } from "../core/db.js";

export type FeedbackSource = "recall" | "surface";

export interface FeedbackEventInput {
  memory_id: string;
  source: FeedbackSource;
  useful: boolean;
  agent_id?: string;
}

export interface FeedbackEventRecord extends FeedbackEventInput {
  id: string;
  created_at: string;
  value: number;
}

export interface FeedbackSummary {
  total: number;
  useful: number;
  not_useful: number;
  score: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function recordFeedbackEvent(
  db: Database.Database,
  input: FeedbackEventInput,
): FeedbackEventRecord {
  const id = newId();
  const created_at = now();
  const agentId = input.agent_id ?? "default";
  const useful = input.useful ? 1 : 0;
  const value = input.useful ? 1 : 0;
  const eventType = `${input.source}:${input.useful ? "useful" : "not_useful"}`;

  const exists = db.prepare("SELECT id FROM memories WHERE id = ?").get(input.memory_id) as { id: string } | undefined;
  if (!exists) {
    throw new Error(`Memory not found: ${input.memory_id}`);
  }

  try {
    db.prepare(
      `INSERT INTO feedback_events (id, memory_id, source, useful, agent_id, event_type, value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.memory_id, input.source, useful, agentId, eventType, value, created_at);
  } catch {
    db.prepare(
      `INSERT INTO feedback_events (id, memory_id, event_type, value, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.memory_id, eventType, value, created_at);
  }

  return {
    id,
    memory_id: input.memory_id,
    source: input.source,
    useful: input.useful,
    agent_id: agentId,
    created_at,
    value,
  };
}

export function getFeedbackSummary(
  db: Database.Database,
  memoryId: string,
  agentId?: string,
): FeedbackSummary {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as total,
              COALESCE(SUM(CASE WHEN useful = 1 THEN 1 ELSE 0 END), 0) as useful,
              COALESCE(SUM(CASE WHEN useful = 0 THEN 1 ELSE 0 END), 0) as not_useful
       FROM feedback_events
       WHERE memory_id = ?
         AND (? IS NULL OR agent_id = ?)`,
    ).get(memoryId, agentId ?? null, agentId ?? null) as {
      total: number;
      useful: number;
      not_useful: number;
    };

    if (!row || row.total === 0) {
      return { total: 0, useful: 0, not_useful: 0, score: 0.5 };
    }

    return {
      total: row.total,
      useful: row.useful,
      not_useful: row.not_useful,
      score: clamp01(row.useful / row.total),
    };
  } catch {
    const row = db.prepare(
      `SELECT COUNT(*) as total,
              COALESCE(SUM(CASE WHEN value >= 0.5 THEN 1 ELSE 0 END), 0) as useful,
              COALESCE(SUM(CASE WHEN value < 0.5 THEN 1 ELSE 0 END), 0) as not_useful,
              COALESCE(AVG(value), 0.5) as avg_value
       FROM feedback_events
       WHERE memory_id = ?`,
    ).get(memoryId) as {
      total: number;
      useful: number;
      not_useful: number;
      avg_value: number;
    };

    if (!row || row.total === 0) {
      return { total: 0, useful: 0, not_useful: 0, score: 0.5 };
    }

    return {
      total: row.total,
      useful: row.useful,
      not_useful: row.not_useful,
      score: clamp01(row.avg_value),
    };
  }
}

export function getFeedbackScore(
  db: Database.Database,
  memoryId: string,
  agentId?: string,
): number {
  return getFeedbackSummary(db, memoryId, agentId).score;
}
