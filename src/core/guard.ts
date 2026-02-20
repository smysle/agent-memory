// AgentMemory v2 — Write Guard (dedup + conflict detection + 4-criterion gate)
import type Database from "better-sqlite3";
import { contentHash, type CreateMemoryInput, type Memory } from "./memory.js";
import { getPathByUri } from "./path.js";
import { tokenize } from "../search/tokenizer.js";

export type GuardAction = "add" | "update" | "skip" | "merge";

export interface GuardResult {
  action: GuardAction;
  reason: string;
  existingId?: string;
  mergedContent?: string;
}

/**
 * Write Guard — decides whether to add, update, skip, or merge a memory.
 *
 * Pipeline:
 * 1. Hash dedup (exact content match → skip)
 * 2. URI conflict (URI exists → update path)
 * 3. BM25 similarity (dynamic threshold → merge or update)
 * 4. Four-criterion gate: Specificity, Novelty, Relevance, Coherence
 */
export function guard(
  db: Database.Database,
  input: CreateMemoryInput & { uri?: string },
): GuardResult {
  const hash = contentHash(input.content);
  const agentId = input.agent_id ?? "default";

  // 1. Hash dedup — exact content match
  const exactMatch = db
    .prepare("SELECT id FROM memories WHERE hash = ? AND agent_id = ?")
    .get(hash, agentId) as { id: string } | undefined;

  if (exactMatch) {
    return { action: "skip", reason: "Exact duplicate (hash match)", existingId: exactMatch.id };
  }

  // 2. URI conflict — URI already exists, update instead of add
  if (input.uri) {
    const existingPath = getPathByUri(db, input.uri);
    if (existingPath) {
      return {
        action: "update",
        reason: `URI ${input.uri} already exists, updating`,
        existingId: existingPath.memory_id,
      };
    }
  }

  // 3. BM25 similarity with dynamic threshold
  const ftsTokens = tokenize(input.content.slice(0, 200));
  const ftsQuery = ftsTokens.length > 0
    ? ftsTokens.slice(0, 8).map((w) => `"${w}"`).join(" OR ")
    : null;

  if (ftsQuery) {
    try {
      const similar = db
        .prepare(
          `SELECT m.id, m.content, m.type, rank
           FROM memories_fts f
           JOIN memories m ON m.id = f.id
           WHERE memories_fts MATCH ? AND m.agent_id = ?
           ORDER BY rank
           LIMIT 3`,
        )
        .all(ftsQuery, agentId) as Array<Memory & { rank: number }>;

      if (similar.length > 0) {
        // Dynamic threshold: use relative scoring instead of hardcoded -10
        // FTS5 rank is negative; more negative = better match
        // Compare top result against token count for relative threshold
        const topRank = Math.abs(similar[0].rank);
        const tokenCount = ftsTokens.length;
        // Threshold: at least 1.5 score per query token indicates strong overlap
        const dynamicThreshold = tokenCount * 1.5;

        if (topRank > dynamicThreshold) {
          const existing = similar[0];
          if (existing.type === input.type) {
            // Same type + high similarity → merge
            const merged = `${existing.content}\n\n[Updated] ${input.content}`;
            return {
              action: "merge",
              reason: `Similar content found (score=${topRank.toFixed(1)}, threshold=${dynamicThreshold.toFixed(1)}), merging`,
              existingId: existing.id,
              mergedContent: merged,
            };
          }
        }
      }
    } catch {
      // FTS query error — continue to gate check
    }
  }

  // 4. Four-criterion gate
  const gateResult = fourCriterionGate(input);
  if (!gateResult.pass) {
    return { action: "skip", reason: `Gate rejected: ${gateResult.failedCriteria.join(", ")}` };
  }

  // All checks passed → add
  return { action: "add", reason: "Passed all guard checks" };
}

/**
 * Four-criterion gate for memory quality.
 * Each criterion scores 0-1, all must pass minimum threshold.
 *
 * 1. Specificity — content has enough substance (not too vague/short)
 * 2. Novelty — content contains information (not just filler words)
 * 3. Relevance — content has identifiable topics/entities
 * 4. Coherence — content is well-formed (not garbled/truncated)
 */
interface GateResult {
  pass: boolean;
  scores: { specificity: number; novelty: number; relevance: number; coherence: number };
  failedCriteria: string[];
}

function fourCriterionGate(input: CreateMemoryInput): GateResult {
  const content = input.content.trim();
  const failed: string[] = [];

  // --- Specificity: content has enough substance ---
  // Minimum length varies by priority: P0/P1 can be shorter
  const priority = input.priority ?? (input.type === "identity" ? 0 : input.type === "emotion" ? 1 : input.type === "knowledge" ? 2 : 3);
  const minLength = priority <= 1 ? 4 : 8;
  const specificity = content.length >= minLength ? Math.min(1, content.length / 50) : 0;
  if (specificity === 0) failed.push(`specificity (too short: ${content.length} < ${minLength} chars)`);

  // --- Novelty: content has information, not just stopwords/filler ---
  const tokens = tokenize(content);
  // After stopword removal, we should have meaningful tokens
  const novelty = tokens.length >= 1 ? Math.min(1, tokens.length / 5) : 0;
  if (novelty === 0) failed.push("novelty (no meaningful tokens after filtering)");

  // --- Relevance: content has identifiable topics ---
  // Check for nouns/entities: CJK chars, capitalized words, numbers, URIs, meaningful length
  const hasCJK = /[\u4e00-\u9fff]/.test(content);
  const hasCapitalized = /[A-Z][a-z]+/.test(content);
  const hasNumbers = /\d+/.test(content);
  const hasURI = /\w+:\/\//.test(content);
  const hasEntityMarkers = /[@#]/.test(content);
  const hasMeaningfulLength = content.length >= 15; // longer content is self-evidently relevant
  const topicSignals = [hasCJK, hasCapitalized, hasNumbers, hasURI, hasEntityMarkers, hasMeaningfulLength].filter(Boolean).length;
  const relevance = topicSignals >= 1 ? Math.min(1, topicSignals / 3) : 0;
  if (relevance === 0) failed.push("relevance (no identifiable topics/entities)");

  // --- Coherence: content is well-formed ---
  // Check: not all caps, not garbled (reasonable char distribution), has word boundaries
  const allCaps = content === content.toUpperCase() && content.length > 20 && /^[A-Z\s]+$/.test(content);
  const hasWhitespaceOrPunctuation = /[\s，。！？,.!?；;：:]/.test(content) || content.length < 30;
  const excessiveRepetition = /(.)\1{9,}/.test(content); // same char 10+ times
  let coherence = 1;
  if (allCaps) { coherence -= 0.5; }
  if (!hasWhitespaceOrPunctuation) { coherence -= 0.3; }
  if (excessiveRepetition) { coherence -= 0.5; }
  coherence = Math.max(0, coherence);
  if (coherence < 0.3) failed.push("coherence (garbled or malformed content)");

  return {
    pass: failed.length === 0,
    scores: { specificity, novelty, relevance, coherence },
    failedCriteria: failed,
  };
}
