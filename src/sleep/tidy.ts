// AgentMemory — Sleep tidy engine (deep sleep phase)
// Compression / merge / archive only. Governance belongs in govern.ts.
import type Database from "better-sqlite3";
import { deleteMemory, type MemoryType } from "../core/memory.js";
import { getDecayedMemories } from "./decay.js";
import { now } from "../core/db.js";

export interface TidyResult {
  archived: number;
  orphansCleaned: number;
  staleDecayed: number;
}

interface StaleDetectionResult {
  stale: boolean;
  reason: string;
  decay_factor: number;
}

interface StalePattern {
  pattern: RegExp;
  type: string;
  decay: number;
  maxAgeDays: number;
}

// event 类型：宽松匹配
const EVENT_STALE_PATTERNS: StalePattern[] = [
  { pattern: /正在|进行中|部署中|处理中|in progress|deploying|working on/i, type: "in_progress", decay: 0.3, maxAgeDays: 7 },
  { pattern: /待办|TODO|等.*回复|等.*确认|需要.*确认/i, type: "pending", decay: 0.5, maxAgeDays: 14 },
  { pattern: /刚才|刚刚|just now|a moment ago/i, type: "ephemeral", decay: 0.2, maxAgeDays: 3 },
];

// knowledge 类型：仅句首锚定
const KNOWLEDGE_STALE_PATTERNS: StalePattern[] = [
  { pattern: /^(TODO|WIP|FIXME|待办|进行中)[：:]/im, type: "pending", decay: 0.5, maxAgeDays: 14 },
  { pattern: /^(刚才|刚刚)/m, type: "ephemeral", decay: 0.2, maxAgeDays: 3 },
];

/**
 * Detect if memory content is stale based on patterns.
 * identity and emotion types never participate in semantic decay.
 */
export function isStaleContent(content: string, type: MemoryType): StaleDetectionResult {
  if (type === "identity" || type === "emotion") {
    return { stale: false, reason: "type excluded", decay_factor: 1.0 };
  }

  const patterns = type === "event" ? EVENT_STALE_PATTERNS : KNOWLEDGE_STALE_PATTERNS;

  for (const { pattern, type: staleType, decay } of patterns) {
    if (pattern.test(content)) {
      return { stale: true, reason: staleType, decay_factor: decay };
    }
  }

  return { stale: false, reason: "no stale patterns matched", decay_factor: 1.0 };
}

/**
 * Get the age threshold in days for a stale pattern type.
 */
function getAgeThresholdDays(staleType: string): number {
  const thresholds: Record<string, number> = {
    in_progress: 7,
    pending: 14,
    ephemeral: 3,
  };
  return thresholds[staleType] ?? 7;
}

/**
 * Run the tidy (deep sleep) cycle:
 * 1. Archive decayed P3 memories (vitality < threshold)
 * 2. Apply semantic decay to stale content
 *
 * Path/orphan cleanup moved to govern.ts in Phase 2.
 */
export function runTidy(
  db: Database.Database,
  opts?: {
    vitalityThreshold?: number;
    agent_id?: string;
  },
): TidyResult {
  const threshold = opts?.vitalityThreshold ?? 0.05;
  const agentId = opts?.agent_id;

  let archived = 0;
  let staleDecayed = 0;

  const transaction = db.transaction(() => {
    // Phase 1: Archive decayed memories
    const decayed = getDecayedMemories(db, threshold, agentId ? { agent_id: agentId } : undefined);
    for (const mem of decayed) {
      deleteMemory(db, mem.id);
      archived += 1;
    }

    // Phase 2: Semantic decay for stale content
    const currentMs = Date.now();
    const currentTime = now();
    const agentCondition = agentId ? "AND agent_id = ?" : "";
    const agentParams = agentId ? [agentId] : [];

    // Only check knowledge (P2) and event (P3) memories with vitality > threshold
    const candidates = db.prepare(
      `SELECT id, content, type, created_at, updated_at, vitality
       FROM memories
       WHERE priority >= 2 AND vitality >= ?
       ${agentCondition}`,
    ).all(threshold, ...agentParams) as Array<{
      id: string;
      content: string;
      type: MemoryType;
      created_at: string;
      updated_at: string;
      vitality: number;
    }>;

    const updateStmt = db.prepare("UPDATE memories SET vitality = ?, updated_at = ? WHERE id = ?");

    for (const mem of candidates) {
      const detection = isStaleContent(mem.content, mem.type);
      if (!detection.stale) continue;

      const createdMs = new Date(mem.created_at).getTime();
      const ageDays = (currentMs - createdMs) / (1000 * 60 * 60 * 24);
      const thresholdDays = getAgeThresholdDays(detection.reason);

      if (ageDays < thresholdDays) continue;

      const newVitality = Math.max(0, mem.vitality * detection.decay_factor);
      if (Math.abs(newVitality - mem.vitality) > 0.001) {
        updateStmt.run(newVitality, currentTime, mem.id);
        staleDecayed += 1;
      }
    }
  });

  transaction();

  return { archived, orphansCleaned: 0, staleDecayed };
}
