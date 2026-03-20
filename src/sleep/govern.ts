// AgentMemory — Governance cycle (memory health maintenance)
import type Database from "better-sqlite3";
import { deleteMemory, archiveMemory, type Memory } from "../core/memory.js";
import { tokenize } from "../search/tokenizer.js";

export interface GovernResult {
  orphanPaths: number;
  emptyMemories: number;
  evicted: number;
  archived: number;
  evictedByType: Record<string, number>;
}

export interface EvictionCandidate {
  memory: Memory;
  redundancy_score: number;
  age_score: number;
  low_feedback_penalty: number;
  low_priority_penalty: number;
  eviction_score: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function overlapScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / Math.max(left.size, right.size);
}

function feedbackPenalty(db: Database.Database, memoryId: string): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as count, COALESCE(AVG(value), 0) as avgValue
       FROM feedback_events
       WHERE memory_id = ?`,
    ).get(memoryId) as { count: number; avgValue: number };

    if (!row || row.count === 0) return 1;
    return clamp01(1 - row.avgValue);
  } catch {
    return 1;
  }
}

function ageScore(memory: Memory, referenceMs = Date.now()): number {
  const createdAt = new Date(memory.created_at).getTime();
  if (Number.isNaN(createdAt)) return 0;
  const ageDays = Math.max(0, (referenceMs - createdAt) / (1000 * 60 * 60 * 24));
  return clamp01(ageDays / 180);
}

export function computeEvictionScore(input: {
  vitality: number;
  redundancy_score: number;
  age_score: number;
  low_feedback_penalty: number;
  low_priority_penalty: number;
}): number {
  return clamp01(
    0.40 * (1 - clamp01(input.vitality))
      + 0.20 * clamp01(input.redundancy_score)
      + 0.20 * clamp01(input.age_score)
      + 0.10 * clamp01(input.low_feedback_penalty)
      + 0.10 * clamp01(input.low_priority_penalty),
  );
}

export function rankEvictionCandidates(
  db: Database.Database,
  opts?: { agent_id?: string },
): EvictionCandidate[] {
  const agentId = opts?.agent_id;
  const rows = db.prepare(
    agentId
      ? `SELECT * FROM memories WHERE agent_id = ? AND priority > 0 AND TRIM(content) != ''`
      : `SELECT * FROM memories WHERE priority > 0 AND TRIM(content) != ''`,
  ).all(...(agentId ? [agentId] : [])) as Memory[];

  const tokenSets = new Map(rows.map((memory) => [memory.id, new Set(tokenize(memory.content))]));

  return rows
    .map((memory) => {
      const ownTokens = tokenSets.get(memory.id) ?? new Set<string>();
      const redundancy = rows
        .filter((candidate) => candidate.id !== memory.id && candidate.type === memory.type)
        .reduce((maxOverlap, candidate) => {
          const candidateTokens = tokenSets.get(candidate.id) ?? new Set<string>();
          return Math.max(maxOverlap, overlapScore(ownTokens, candidateTokens));
        }, 0);

      const candidate: EvictionCandidate = {
        memory,
        redundancy_score: redundancy,
        age_score: ageScore(memory),
        low_feedback_penalty: feedbackPenalty(db, memory.id),
        low_priority_penalty: clamp01(memory.priority / 3),
        eviction_score: 0,
      };

      candidate.eviction_score = computeEvictionScore({
        vitality: memory.vitality,
        redundancy_score: candidate.redundancy_score,
        age_score: candidate.age_score,
        low_feedback_penalty: candidate.low_feedback_penalty,
        low_priority_penalty: candidate.low_priority_penalty,
      });

      return candidate;
    })
    .sort((left, right) => {
      if (right.eviction_score !== left.eviction_score) {
        return right.eviction_score - left.eviction_score;
      }
      return left.memory.priority - right.memory.priority;
    });
}

function parseEnvInt(envKey: string): number | null {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface TieredCapacity {
  identity: number | null;  // null = unlimited (default)
  emotion: number | null;
  knowledge: number | null;
  event: number | null;
  total: number;
}

export function getTieredCapacity(opts?: { maxMemories?: number }): TieredCapacity {
  const envMax = parseEnvInt("AGENT_MEMORY_MAX_MEMORIES");
  return {
    identity: parseEnvInt("AGENT_MEMORY_MAX_IDENTITY"),    // default: null (unlimited)
    emotion: parseEnvInt("AGENT_MEMORY_MAX_EMOTION") ?? 50,
    knowledge: parseEnvInt("AGENT_MEMORY_MAX_KNOWLEDGE") ?? 250,
    event: parseEnvInt("AGENT_MEMORY_MAX_EVENT") ?? 50,
    total: opts?.maxMemories ?? (envMax ?? 350),
  };
}

/**
 * Run governance checks and cleanup:
 * 1. Remove orphan paths (no parent memory)
 * 2. Remove empty memories (blank content)
 * 3. Evict low-value memories when over capacity using tiered + global eviction
 *
 * Tiered capacity can be set via env vars:
 *   AGENT_MEMORY_MAX_IDENTITY, AGENT_MEMORY_MAX_EMOTION,
 *   AGENT_MEMORY_MAX_KNOWLEDGE, AGENT_MEMORY_MAX_EVENT,
 *   AGENT_MEMORY_MAX_MEMORIES (global cap, default 350)
 *
 * Evicted memories are archived to memory_archive before deletion.
 */
export function runGovern(
  db: Database.Database,
  opts?: { agent_id?: string; maxMemories?: number },
): GovernResult {
  const agentId = opts?.agent_id;
  const capacity = getTieredCapacity(opts);
  let orphanPaths = 0;
  let emptyMemories = 0;
  let evicted = 0;
  let archived = 0;
  const evictedByType: Record<string, number> = {};

  const transaction = db.transaction(() => {
    // Step 1: Clean orphan paths
    const pathResult = agentId
      ? db.prepare(
        `DELETE FROM paths
         WHERE agent_id = ?
           AND memory_id NOT IN (SELECT id FROM memories WHERE agent_id = ?)`,
      ).run(agentId, agentId)
      : db.prepare("DELETE FROM paths WHERE memory_id NOT IN (SELECT id FROM memories)").run();
    orphanPaths = pathResult.changes;

    // Step 2: Clean empty memories
    const emptyResult = agentId
      ? db.prepare("DELETE FROM memories WHERE agent_id = ? AND TRIM(content) = ''").run(agentId)
      : db.prepare("DELETE FROM memories WHERE TRIM(content) = ''").run();
    emptyMemories = emptyResult.changes;

    // Step 3: Tiered eviction — per-type limits
    const typeLimits: Array<{ type: string; limit: number | null }> = [
      { type: "identity", limit: capacity.identity },
      { type: "emotion", limit: capacity.emotion },
      { type: "knowledge", limit: capacity.knowledge },
      { type: "event", limit: capacity.event },
    ];

    // Build all eviction candidates once (sorted by eviction_score desc)
    const allCandidates = rankEvictionCandidates(db, { agent_id: agentId });
    const evictedIds = new Set<string>();

    for (const { type, limit } of typeLimits) {
      if (limit === null) continue; // null = unlimited, skip

      const typeCount = (
        db.prepare(
          agentId
            ? "SELECT COUNT(*) as c FROM memories WHERE agent_id = ? AND type = ?"
            : "SELECT COUNT(*) as c FROM memories WHERE type = ?",
        ).get(...(agentId ? [agentId, type] : [type])) as { c: number }
      ).c;

      const excess = Math.max(0, typeCount - limit);
      if (excess <= 0) continue;

      // Get candidates of this type, sorted by eviction_score desc
      const typeCandidates = allCandidates
        .filter((c) => c.memory.type === type && !evictedIds.has(c.memory.id));

      const toEvict = typeCandidates.slice(0, excess);
      for (const candidate of toEvict) {
        const result = archiveMemory(db, candidate.memory.id, "eviction");
        evictedIds.add(candidate.memory.id);
        evicted += 1;
        if (result === "archived") archived += 1;
        evictedByType[type] = (evictedByType[type] ?? 0) + 1;
      }
    }

    // Step 4: Global cap eviction
    const total = (
      db.prepare(agentId ? "SELECT COUNT(*) as c FROM memories WHERE agent_id = ?" : "SELECT COUNT(*) as c FROM memories").get(...(agentId ? [agentId] : [])) as { c: number }
    ).c;

    const globalExcess = Math.max(0, total - capacity.total);
    if (globalExcess > 0) {
      const globalCandidates = allCandidates
        .filter((c) => !evictedIds.has(c.memory.id));

      const toEvict = globalCandidates.slice(0, globalExcess);
      for (const candidate of toEvict) {
        const result = archiveMemory(db, candidate.memory.id, "eviction");
        evictedIds.add(candidate.memory.id);
        evicted += 1;
        if (result === "archived") archived += 1;
        const t = candidate.memory.type;
        evictedByType[t] = (evictedByType[t] ?? 0) + 1;
      }
    }
  });

  transaction();

  return { orphanPaths, emptyMemories, evicted, archived, evictedByType };
}
