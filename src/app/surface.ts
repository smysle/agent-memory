import type Database from "better-sqlite3";
import { listMemories, type Memory, type MemoryType } from "../core/memory.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { priorityPrior } from "../search/hybrid.js";
import { getEmbeddingProviderFromEnv } from "../search/providers.js";
import { searchBM25 } from "../search/bm25.js";
import { tokenize } from "../search/tokenizer.js";
import { searchByVector } from "../search/vector.js";
import { getFeedbackSummary, type FeedbackSummary } from "./feedback.js";

export type SurfaceIntent = "factual" | "preference" | "temporal" | "planning" | "design";

export interface SurfaceInput {
  query?: string;
  task?: string;
  recent_turns?: string[];
  intent?: SurfaceIntent;
  types?: MemoryType[];
  limit?: number;
  agent_id?: string;
  provider?: EmbeddingProvider | null;
  min_vitality?: number;
}

export interface SurfaceResult {
  memory: Memory;
  score: number;
  semantic_score: number;
  lexical_score: number;
  task_match: number;
  vitality: number;
  priority_prior: number;
  feedback_score: number;
  feedback_summary: FeedbackSummary;
  reason_codes: string[];
  lexical_rank?: number;
  semantic_rank?: number;
  semantic_similarity?: number;
}

export interface SurfaceResponse {
  count: number;
  query?: string;
  task?: string;
  intent?: SurfaceIntent;
  results: SurfaceResult[];
}

interface CandidateSignal {
  memory: Memory;
  queryRank?: number;
  taskRank?: number;
  recentRank?: number;
  semanticRank?: number;
  semanticSimilarity?: number;
}

const INTENT_PRIORS: Record<SurfaceIntent, Record<MemoryType, number>> = {
  factual: {
    identity: 0.25,
    emotion: 0.15,
    knowledge: 1.0,
    event: 0.8,
  },
  preference: {
    identity: 1.0,
    emotion: 0.85,
    knowledge: 0.55,
    event: 0.25,
  },
  temporal: {
    identity: 0.15,
    emotion: 0.35,
    knowledge: 0.5,
    event: 1.0,
  },
  planning: {
    identity: 0.65,
    emotion: 0.2,
    knowledge: 1.0,
    event: 0.6,
  },
  design: {
    identity: 0.8,
    emotion: 0.35,
    knowledge: 1.0,
    event: 0.25,
  },
};

const DESIGN_HINT_RE = /\b(ui|ux|design|style|component|layout|brand|palette|theme)\b|风格|界面|设计|配色|低饱和|玻璃拟态|渐变/i;
const PLANNING_HINT_RE = /\b(plan|planning|todo|next|ship|build|implement|roadmap|task|milestone)\b|计划|下一步|待办|实现|重构/i;
const FACTUAL_HINT_RE = /\b(what|fact|constraint|rule|docs|document|api|status)\b|规则|约束|文档|接口|事实/i;
const TEMPORAL_HINT_RE = /\b(today|yesterday|tomorrow|recent|before|after|when|timeline)\b|今天|昨天|明天|最近|时间线|何时/i;
const PREFERENCE_HINT_RE = /\b(prefer|preference|like|dislike|avoid|favorite)\b|喜欢|偏好|不喜欢|避免|讨厌/i;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function uniqueTokenSet(values: Array<string | undefined>): Set<string> {
  return new Set(
    values
      .flatMap((value) => tokenize(value ?? ""))
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

function overlapScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }

  return clamp01(shared / Math.max(left.size, right.size));
}

function rankScore(rank: number | undefined, window: number): number {
  if (!rank) return 0;
  return clamp01(1 - (rank - 1) / Math.max(window, 1));
}

function topicLabel(...parts: Array<string | undefined>): string {
  const token = parts
    .flatMap((part) => tokenize(part ?? ""))
    .find((value) => value.trim().length > 1);

  const label = (token ?? "context")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  return label || "context";
}

function intentKeywordBoost(memory: Memory, intent: SurfaceIntent): number {
  const content = memory.content;
  switch (intent) {
    case "design":
      return DESIGN_HINT_RE.test(content) ? 1 : 0.65;
    case "planning":
      return PLANNING_HINT_RE.test(content) ? 1 : 0.7;
    case "factual":
      return FACTUAL_HINT_RE.test(content) ? 1 : 0.75;
    case "temporal":
      return TEMPORAL_HINT_RE.test(content) ? 1 : 0.75;
    case "preference":
      return PREFERENCE_HINT_RE.test(content) ? 1 : 0.8;
  }
}

function intentMatch(memory: Memory, intent?: SurfaceIntent): number {
  if (!intent) return 0;
  const prior = INTENT_PRIORS[intent][memory.type] ?? 0;
  return clamp01(prior * intentKeywordBoost(memory, intent));
}

function buildReasonCodes(input: {
  memory: Memory;
  query?: string;
  task?: string;
  intent?: SurfaceIntent;
  semanticScore: number;
  lexicalScore: number;
  taskMatch: number;
  feedbackScore: number;
}): string[] {
  const reasons = new Set<string>();
  reasons.add(`type:${input.memory.type}`);

  if (input.semanticScore > 0.2) {
    reasons.add(`semantic:${topicLabel(input.query, input.task)}`);
  }
  if (input.lexicalScore > 0.2 && input.query) {
    reasons.add(`lexical:${topicLabel(input.query)}`);
  }
  if (input.taskMatch > 0.2) {
    reasons.add(`task:${topicLabel(input.task, input.intent)}`);
  }
  if (input.intent) {
    reasons.add(`intent:${input.intent}`);
  }
  if (input.feedbackScore >= 0.67) {
    reasons.add("feedback:reinforced");
  } else if (input.feedbackScore <= 0.33) {
    reasons.add("feedback:negative");
  }

  return [...reasons];
}

function collectBranch(
  signals: Map<string, CandidateSignal>,
  rows: Array<{ memory: Memory; rank: number }>,
  key: "queryRank" | "taskRank" | "recentRank" | "semanticRank",
  similarity?: Map<string, number>,
): void {
  for (const row of rows) {
    const existing = signals.get(row.memory.id) ?? { memory: row.memory };
    const currentRank = existing[key];
    if (currentRank === undefined || row.rank < currentRank) {
      existing[key] = row.rank;
    }
    if (similarity) {
      const currentSimilarity = similarity.get(row.memory.id);
      if (currentSimilarity !== undefined) {
        existing.semanticSimilarity = Math.max(existing.semanticSimilarity ?? 0, currentSimilarity);
      }
    }
    signals.set(row.memory.id, existing);
  }
}

export async function surfaceMemories(
  db: Database.Database,
  input: SurfaceInput,
): Promise<SurfaceResponse> {
  const agentId = input.agent_id ?? "default";
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const lexicalWindow = Math.max(24, limit * 6);
  const minVitality = input.min_vitality ?? 0.05;
  const provider = input.provider === undefined ? getEmbeddingProviderFromEnv() : input.provider;
  const signals = new Map<string, CandidateSignal>();

  const trimmedQuery = input.query?.trim();
  const trimmedTask = input.task?.trim();
  const recentTurns = (input.recent_turns ?? []).map((turn) => turn.trim()).filter(Boolean).slice(-4);
  const queryTokens = uniqueTokenSet([trimmedQuery, ...recentTurns]);
  const taskTokens = uniqueTokenSet([trimmedTask]);

  if (trimmedQuery) {
    collectBranch(
      signals,
      searchBM25(db, trimmedQuery, {
        agent_id: agentId,
        limit: lexicalWindow,
        min_vitality: minVitality,
      }),
      "queryRank",
    );
  }

  if (trimmedTask) {
    collectBranch(
      signals,
      searchBM25(db, trimmedTask, {
        agent_id: agentId,
        limit: lexicalWindow,
        min_vitality: minVitality,
      }),
      "taskRank",
    );
  }

  if (recentTurns.length > 0) {
    collectBranch(
      signals,
      searchBM25(db, recentTurns.join(" "), {
        agent_id: agentId,
        limit: lexicalWindow,
        min_vitality: minVitality,
      }),
      "recentRank",
    );
  }

  const semanticQuery = [trimmedQuery, trimmedTask, ...recentTurns].filter(Boolean).join("\n").trim();
  if (provider && semanticQuery) {
    try {
      const [queryVector] = await provider.embed([semanticQuery]);
      if (queryVector) {
        const vectorRows = searchByVector(db, queryVector, {
          providerId: provider.id,
          agent_id: agentId,
          limit: lexicalWindow,
          min_vitality: minVitality,
        });
        const similarity = new Map(vectorRows.map((row) => [row.memory.id, row.similarity]));
        collectBranch(signals, vectorRows, "semanticRank", similarity);
      }
    } catch {
      // Surface should still work in lexical-only mode.
    }
  }

  const fallbackMemories = listMemories(db, {
    agent_id: agentId,
    min_vitality: minVitality,
    limit: Math.max(48, lexicalWindow),
  });

  for (const memory of fallbackMemories) {
    if (!signals.has(memory.id)) {
      signals.set(memory.id, { memory });
    }
  }

  const results = [...signals.values()]
    .map((signal) => signal.memory)
    .filter((memory) => memory.vitality >= minVitality)
    .filter((memory) => (input.types?.length ? input.types.includes(memory.type) : true))
    .map((memory) => {
      const signal = signals.get(memory.id) ?? { memory };
      const memoryTokens = new Set(tokenize(memory.content));
      const lexicalOverlap = overlapScore(memoryTokens, queryTokens);
      const taskOverlap = overlapScore(memoryTokens, taskTokens);
      const lexicalScore = clamp01(
        0.45 * rankScore(signal.queryRank, lexicalWindow)
          + 0.15 * rankScore(signal.recentRank, lexicalWindow)
          + 0.15 * rankScore(signal.taskRank, lexicalWindow)
          + 0.25 * lexicalOverlap,
      );
      const semanticScore = signal.semanticSimilarity !== undefined
        ? clamp01(Math.max(signal.semanticSimilarity, lexicalOverlap * 0.7))
        : (trimmedQuery || recentTurns.length > 0)
          ? clamp01(lexicalOverlap * 0.7)
          : 0;
      const intentScore = intentMatch(memory, input.intent);
      const taskMatch = trimmedTask
        ? clamp01(0.7 * taskOverlap + 0.3 * intentScore)
        : intentScore;
      const priorityScore = priorityPrior(memory.priority);
      const feedbackSummary = getFeedbackSummary(db, memory.id, agentId);
      const feedbackScore = feedbackSummary.score;
      const score = clamp01(
        0.35 * semanticScore
          + 0.20 * lexicalScore
          + 0.15 * taskMatch
          + 0.10 * memory.vitality
          + 0.10 * priorityScore
          + 0.10 * feedbackScore,
      );

      return {
        memory,
        score,
        semantic_score: semanticScore,
        lexical_score: lexicalScore,
        task_match: taskMatch,
        vitality: memory.vitality,
        priority_prior: priorityScore,
        feedback_score: feedbackScore,
        feedback_summary: feedbackSummary,
        reason_codes: buildReasonCodes({
          memory,
          query: semanticQuery || trimmedQuery,
          task: trimmedTask,
          intent: input.intent,
          semanticScore,
          lexicalScore,
          taskMatch,
          feedbackScore,
        }),
        lexical_rank: signal.queryRank ?? signal.recentRank ?? signal.taskRank,
        semantic_rank: signal.semanticRank,
        semantic_similarity: signal.semanticSimilarity,
      } satisfies SurfaceResult;
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.semantic_score !== left.semantic_score) return right.semantic_score - left.semantic_score;
      if (right.lexical_score !== left.lexical_score) return right.lexical_score - left.lexical_score;
      if (left.memory.priority !== right.memory.priority) return left.memory.priority - right.memory.priority;
      return right.memory.updated_at.localeCompare(left.memory.updated_at);
    })
    .slice(0, limit);

  return {
    count: results.length,
    query: trimmedQuery,
    task: trimmedTask,
    intent: input.intent,
    results,
  };
}
