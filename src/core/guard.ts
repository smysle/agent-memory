// AgentMemory v4 — semantic Write Guard (dedup + merge selection + four-criterion gate)
import type Database from "better-sqlite3";
import { recallMemories, type HybridRecallResult } from "../search/hybrid.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { getEmbeddingProviderFromEnv } from "../search/providers.js";
import { tokenize } from "../search/tokenizer.js";
import { parseUri, getPathByUri } from "./path.js";
import { buildMergePlan, type MergePlan } from "./merge.js";
import { contentHash, type CreateMemoryInput, type Memory } from "./memory.js";

export type GuardAction = "add" | "update" | "skip" | "merge";

export interface DedupScoreBreakdown {
  semantic_similarity: number;
  lexical_overlap: number;
  uri_scope_match: number;
  entity_overlap: number;
  time_proximity: number;
  dedup_score: number;
}

export interface GuardResult {
  action: GuardAction;
  reason: string;
  existingId?: string;
  updatedContent?: string;
  mergedContent?: string;
  mergePlan?: MergePlan;
  score?: DedupScoreBreakdown;
}

export interface GuardInput extends CreateMemoryInput {
  uri?: string;
  provider?: EmbeddingProvider | null;
  candidateLimit?: number;
  conservative?: boolean;
  now?: string;
}

interface GuardCandidate {
  result: HybridRecallResult;
  uri: string | null;
  domain: string | null;
  score: DedupScoreBreakdown;
}

const NEAR_EXACT_THRESHOLD = 0.93;
const MERGE_THRESHOLD = 0.82;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function uniqueTokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

function overlapScore(left: Iterable<string>, right: Iterable<string>): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }

  return shared / Math.max(a.size, b.size);
}

function extractEntities(text: string): Set<string> {
  const matches = text.match(/[A-Z][A-Za-z0-9_-]+|\d+(?:[-/:]\d+)*|[#@][\w-]+|[\u4e00-\u9fff]{2,}|\w+:\/\/[^\s]+/g) ?? [];
  return new Set(matches.map((value) => value.trim()).filter(Boolean));
}

function safeDomain(uri?: string | null): string | null {
  if (!uri) return null;
  try {
    return parseUri(uri).domain;
  } catch {
    return null;
  }
}

function getPrimaryUri(db: Database.Database, memoryId: string, agentId: string): string | null {
  const row = db
    .prepare("SELECT uri FROM paths WHERE memory_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(memoryId, agentId) as { uri: string } | undefined;
  return row?.uri ?? null;
}

function uriScopeMatch(inputUri?: string, candidateUri?: string | null): number {
  if (inputUri && candidateUri) {
    if (inputUri === candidateUri) return 1;
    const inputDomain = safeDomain(inputUri);
    const candidateDomain = safeDomain(candidateUri);
    if (inputDomain && candidateDomain && inputDomain === candidateDomain) return 0.85;
    return 0;
  }

  if (!inputUri && !candidateUri) {
    return 0.65;
  }

  const inputDomain = safeDomain(inputUri ?? null);
  const candidateDomain = safeDomain(candidateUri ?? null);
  if (inputDomain && candidateDomain && inputDomain === candidateDomain) {
    return 0.75;
  }
  return 0.2;
}

function extractObservedAt(parts: Array<string | null | undefined>, fallback?: string | null): Date | null {
  for (const part of parts) {
    if (!part) continue;
    const match = part.match(/(20\d{2}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/);
    if (!match) continue;
    const iso = match[2] ? `${match[1]}T${match[2]}Z` : `${match[1]}T00:00:00Z`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  if (fallback) {
    const parsed = new Date(fallback);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

function timeProximity(input: GuardInput, memory: Memory, candidateUri?: string | null): number {
  if (input.type !== "event") {
    return 1;
  }

  const inputTime = extractObservedAt([input.uri, input.source, input.content], input.now ?? null);
  const existingTime = extractObservedAt([candidateUri, memory.source, memory.content], memory.created_at);
  if (!inputTime || !existingTime) {
    return 0.5;
  }

  const diffDays = Math.abs(inputTime.getTime() - existingTime.getTime()) / (1000 * 60 * 60 * 24);
  return clamp01(1 - diffDays / 7);
}

function scoreCandidate(input: GuardInput, candidate: HybridRecallResult, candidateUri?: string | null): DedupScoreBreakdown {
  const lexicalOverlap = overlapScore(uniqueTokenSet(input.content), uniqueTokenSet(candidate.memory.content));
  const entityOverlap = Math.max(
    overlapScore(extractEntities(input.content), extractEntities(candidate.memory.content)),
    lexicalOverlap * 0.75,
  );
  const uriMatch = uriScopeMatch(input.uri, candidateUri);
  const temporal = timeProximity(input, candidate.memory, candidateUri);
  const semantic = clamp01(candidate.vector_score ?? lexicalOverlap);
  const dedupScore = clamp01(
    0.50 * semantic
      + 0.20 * lexicalOverlap
      + 0.15 * uriMatch
      + 0.10 * entityOverlap
      + 0.05 * temporal,
  );

  return {
    semantic_similarity: semantic,
    lexical_overlap: lexicalOverlap,
    uri_scope_match: uriMatch,
    entity_overlap: entityOverlap,
    time_proximity: temporal,
    dedup_score: dedupScore,
  };
}

async function recallCandidates(db: Database.Database, input: GuardInput, agentId: string): Promise<GuardCandidate[]> {
  const provider = input.provider === undefined ? getEmbeddingProviderFromEnv() : input.provider;
  const response = await recallMemories(db, input.content, {
    agent_id: agentId,
    limit: Math.max(6, input.candidateLimit ?? 8),
    lexicalLimit: Math.max(8, input.candidateLimit ?? 8),
    vectorLimit: Math.max(8, input.candidateLimit ?? 8),
    provider,
    recordAccess: false,
  });

  return response.results
    .filter((row) => row.memory.type === input.type)
    .map((row) => {
      const uri = getPrimaryUri(db, row.memory.id, agentId);
      return {
        result: row,
        uri,
        domain: safeDomain(uri),
        score: scoreCandidate(input, row, uri),
      };
    })
    .sort((left, right) => right.score.dedup_score - left.score.dedup_score);
}

/**
 * Four-criterion gate for memory quality.
 * Each criterion scores 0-1, all must pass minimum threshold.
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
  const novelty = tokens.length >= 1 ? Math.min(1, tokens.length / 5) : 0;
  if (novelty === 0) failed.push("novelty (no meaningful tokens after filtering)");

  // --- Relevance: content has identifiable topics ---
  const hasCJK = /[\u4e00-\u9fff]/.test(content);
  const hasCapitalized = /[A-Z][a-z]+/.test(content);
  const hasNumbers = /\d+/.test(content);
  const hasURI = /\w+:\/\//.test(content);
  const hasEntityMarkers = /[@#]/.test(content);
  const hasMeaningfulLength = content.length >= 15;
  const topicSignals = [hasCJK, hasCapitalized, hasNumbers, hasURI, hasEntityMarkers, hasMeaningfulLength].filter(Boolean).length;
  const relevance = topicSignals >= 1 ? Math.min(1, topicSignals / 3) : 0;
  if (relevance === 0) failed.push("relevance (no identifiable topics/entities)");

  // --- Coherence: content is well-formed ---
  const allCaps = content === content.toUpperCase() && content.length > 20 && /^[A-Z\s]+$/.test(content);
  const hasWhitespaceOrPunctuation = /[\s，。！？,.!?；;：:]/.test(content) || content.length < 30;
  const excessiveRepetition = /(.)\1{9,}/.test(content);
  let coherence = 1;
  if (allCaps) coherence -= 0.5;
  if (!hasWhitespaceOrPunctuation) coherence -= 0.3;
  if (excessiveRepetition) coherence -= 0.5;
  coherence = Math.max(0, coherence);
  if (coherence < 0.3) failed.push("coherence (garbled or malformed content)");

  return {
    pass: failed.length === 0,
    scores: { specificity, novelty, relevance, coherence },
    failedCriteria: failed,
  };
}

export async function guard(
  db: Database.Database,
  input: GuardInput,
): Promise<GuardResult> {
  const hash = contentHash(input.content);
  const agentId = input.agent_id ?? "default";

  // 1. exact hash dedup
  const exactMatch = db
    .prepare("SELECT id FROM memories WHERE hash = ? AND agent_id = ?")
    .get(hash, agentId) as { id: string } | undefined;

  if (exactMatch) {
    return { action: "skip", reason: "Exact duplicate (hash match)", existingId: exactMatch.id };
  }

  // 2. URI conflict check
  if (input.uri) {
    const existingPath = getPathByUri(db, input.uri, agentId);
    if (existingPath) {
      return {
        action: "update",
        reason: `URI ${input.uri} already exists, updating canonical content`,
        existingId: existingPath.memory_id,
        updatedContent: input.content,
      };
    }
  }

  const gateResult = fourCriterionGate(input);
  if (!gateResult.pass) {
    return { action: "skip", reason: `Gate rejected: ${gateResult.failedCriteria.join(", ")}` };
  }

  if (input.conservative) {
    return { action: "add", reason: "Conservative mode enabled; semantic dedup disabled" };
  }

  // 3~5. hybrid candidate recall + semantic scoring + merge policy selection
  const candidates = await recallCandidates(db, input, agentId);
  const best = candidates[0];

  if (!best) {
    return { action: "add", reason: "No relevant semantic candidates found" };
  }

  const score = best.score;
  if (score.dedup_score >= NEAR_EXACT_THRESHOLD) {
    const shouldUpdateMetadata = Boolean(input.uri && !getPathByUri(db, input.uri, agentId));
    return {
      action: shouldUpdateMetadata ? "update" : "skip",
      reason: shouldUpdateMetadata
        ? `Near-exact duplicate detected (score=${score.dedup_score.toFixed(3)}), updating metadata`
        : `Near-exact duplicate detected (score=${score.dedup_score.toFixed(3)})`,
      existingId: best.result.memory.id,
      score,
    };
  }

  if (score.dedup_score >= MERGE_THRESHOLD) {
    const mergePlan = buildMergePlan({
      existing: best.result.memory,
      incoming: {
        content: input.content,
        type: input.type,
        source: input.source,
      },
    });

    return {
      action: "merge",
      reason: `Semantic near-duplicate detected (score=${score.dedup_score.toFixed(3)}), applying ${mergePlan.strategy}`,
      existingId: best.result.memory.id,
      mergedContent: mergePlan.content,
      mergePlan,
      score,
    };
  }

  return {
    action: "add",
    reason: `Semantic score below merge threshold (score=${score.dedup_score.toFixed(3)})`,
    score,
  };
}
