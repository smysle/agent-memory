// AgentMemory v2 — Intent classifier
// Routes search queries to optimal strategies
// Enhanced Chinese support with jieba tokenization

import { tokenize } from "./tokenizer.js";

export type SearchIntent = "factual" | "exploratory" | "temporal" | "causal";

export interface IntentResult {
  intent: SearchIntent;
  confidence: number;
}

// Keyword patterns for intent detection (EN + CN)
const INTENT_PATTERNS: Record<SearchIntent, RegExp[]> = {
  factual: [
    // English
    /^(what|who|where|which|how much|how many)\b/i,
    /\b(name|address|number|password|config|setting)\b/i,
    // Chinese - questions about facts
    /是(什么|谁|哪|啥)/,
    /叫(什么|啥)/,
    /(名字|地址|号码|密码|配置|设置|账号|邮箱|链接|版本)/,
    /(多少|几个|哪个|哪些|哪里)/,
    // Chinese - lookup patterns
    /(查一下|找一下|看看|搜一下)/,
    /(.+)是什么$/,
  ],
  temporal: [
    // English
    /^(when|what time|how long)\b/i,
    /\b(yesterday|today|tomorrow|last week|recently|ago|before|after)\b/i,
    /\b(first|latest|newest|oldest|previous|next)\b/i,
    // Chinese - time expressions
    /什么时候/,
    /(昨天|今天|明天|上周|下周|最近|以前|之前|之后|刚才|刚刚)/,
    /(几月|几号|几点|多久|多长时间)/,
    /(上次|下次|第一次|最后一次|那天|那时)/,
    // Date patterns
    /\d{4}[-/.]\d{1,2}/,
    /\d{1,2}月\d{1,2}[日号]/,
    // Chinese - temporal context
    /(历史|记录|日志|以来|至今|期间)/,
  ],
  causal: [
    // English
    /^(why|how come|what caused)\b/i,
    /\b(because|due to|reason|cause|result)\b/i,
    // Chinese - causal questions
    /为(什么|啥|何)/,
    /(原因|导致|造成|引起|因为|所以|结果)/,
    /(怎么回事|怎么了|咋回事|咋了)/,
    /(为啥|凭啥|凭什么)/,
    // Chinese - problem/diagnosis
    /(出(了|了什么)?问题|报错|失败|出错|bug)/,
  ],
  exploratory: [
    // English
    /^(how|tell me about|explain|describe|show me)\b/i,
    /^(what do you think|what about|any)\b/i,
    /\b(overview|summary|list|compare)\b/i,
    // Chinese - exploratory
    /(怎么样|怎样|如何)/,
    /(介绍|说说|讲讲|聊聊|谈谈)/,
    /(有哪些|有什么|有没有)/,
    /(关于|对于|至于|关联)/,
    /(总结|概括|梳理|回顾|盘点)/,
    // Chinese - opinion/analysis
    /(看法|想法|意见|建议|评价|感觉|觉得)/,
    /(对比|比较|区别|差异|优缺点)/,
  ],
};

// Chinese structural markers that boost certain intents
const CN_STRUCTURE_BOOSTS: Record<SearchIntent, RegExp[]> = {
  factual: [/^.{1,6}(是什么|叫什么|在哪)/, /^(谁|哪)/],
  temporal: [/^(什么时候|上次|最近)/, /(时间|日期)$/],
  causal: [/^(为什么|为啥)/, /(为什么|怎么回事)$/],
  exploratory: [/^(怎么|如何|说说)/, /(哪些|什么样)$/],
};

/**
 * Classify the intent of a search query.
 * Uses keyword pattern matching + structural analysis.
 * Enhanced for Chinese with jieba-aware token analysis.
 */
export function classifyIntent(query: string): IntentResult {
  const scores: Record<SearchIntent, number> = {
    factual: 0,
    exploratory: 0,
    temporal: 0,
    causal: 0,
  };

  // Pattern matching
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(query)) {
        scores[intent as SearchIntent] += 1;
      }
    }
  }

  // Chinese structural boosts (sentence-level patterns worth more)
  for (const [intent, patterns] of Object.entries(CN_STRUCTURE_BOOSTS)) {
    for (const pattern of patterns) {
      if (pattern.test(query)) {
        scores[intent as SearchIntent] += 0.5;
      }
    }
  }

  // Token-based analysis: short queries with no pattern match → factual
  const tokens = tokenize(query);
  const totalPatternScore = Object.values(scores).reduce((a, b) => a + b, 0);
  if (totalPatternScore === 0 && tokens.length <= 3) {
    // Short query with no intent signal = likely a factual lookup
    scores.factual += 1;
  }

  // Find highest scoring intent
  let maxIntent: SearchIntent = "factual";
  let maxScore = 0;

  for (const [intent, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxIntent = intent as SearchIntent;
    }
  }

  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = totalScore > 0 ? Math.min(0.95, maxScore / totalScore) : 0.5;

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
