// AgentMemory v2 — Intent classifier (from Memory Palace)
// Routes search queries to optimal strategies

export type SearchIntent = "factual" | "exploratory" | "temporal" | "causal";

export interface IntentResult {
  intent: SearchIntent;
  confidence: number;
}

// Keyword patterns for intent detection
const INTENT_PATTERNS: Record<SearchIntent, RegExp[]> = {
  factual: [
    /^(what|who|where|which|how much|how many)/i,
    /是(什么|谁|哪)/,
    /叫什么/,
    /名字/,
    /地址/,
    /号码/,
    /密码/,
    /配置/,
    /设置/,
  ],
  temporal: [
    /^(when|what time|how long)/i,
    /(yesterday|today|last week|recently|ago|before|after)/i,
    /什么时候/,
    /(昨天|今天|上周|最近|以前|之前|之后)/,
    /\d{4}[-/]\d{1,2}/,
    /(几月|几号|几点)/,
  ],
  causal: [
    /^(why|how come|what caused)/i,
    /^(because|due to|reason)/i,
    /为什么/,
    /原因/,
    /导致/,
    /怎么回事/,
    /为啥/,
  ],
  exploratory: [
    /^(how|tell me about|explain|describe)/i,
    /^(what do you think|what about)/i,
    /怎么样/,
    /介绍/,
    /说说/,
    /讲讲/,
    /有哪些/,
    /关于/,
  ],
};

/**
 * Classify the intent of a search query.
 * Uses keyword scoring — no LLM needed.
 */
export function classifyIntent(query: string): IntentResult {
  const scores: Record<SearchIntent, number> = {
    factual: 0,
    exploratory: 0,
    temporal: 0,
    causal: 0,
  };

  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(query)) {
        scores[intent as SearchIntent] += 1;
      }
    }
  }

  // Find highest scoring intent
  let maxIntent: SearchIntent = "factual"; // default
  let maxScore = 0;

  for (const [intent, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxIntent = intent as SearchIntent;
    }
  }

  // If no clear signal, default to factual
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = totalScore > 0 ? maxScore / totalScore : 0.5;

  return { intent: maxIntent, confidence };
}

/**
 * Get search strategy based on intent
 */
export function getStrategy(intent: SearchIntent): {
  boostRecent: boolean;
  boostPriority: boolean;
  limit: number;
} {
  switch (intent) {
    case "factual":
      return { boostRecent: false, boostPriority: true, limit: 5 };
    case "temporal":
      return { boostRecent: true, boostPriority: false, limit: 10 };
    case "causal":
      return { boostRecent: false, boostPriority: false, limit: 10 };
    case "exploratory":
      return { boostRecent: false, boostPriority: false, limit: 15 };
  }
}
