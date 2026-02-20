// AgentMemory v2 — Intent classifier
// Routes search queries to optimal strategies
// Supports English + Chinese with weighted pattern matching

export type SearchIntent = "factual" | "exploratory" | "temporal" | "causal";

export interface IntentResult {
  intent: SearchIntent;
  confidence: number;
}

// Weighted keyword patterns for intent detection
// Each pattern has a weight (default 1.0) for fine-grained scoring
interface WeightedPattern {
  pattern: RegExp;
  weight: number;
}

function p(pattern: RegExp, weight = 1.0): WeightedPattern {
  return { pattern, weight };
}

const INTENT_PATTERNS: Record<SearchIntent, WeightedPattern[]> = {
  factual: [
    // English
    p(/^(what|who|where|which)\b/i, 1.5),
    p(/^(how much|how many)\b/i, 1.2),
    p(/\b(name|address|number|password|config|setting|version)\b/i),
    // Chinese - expanded
    p(/是(什么|谁|哪|啥)/, 1.5),
    p(/叫(什么|啥)/, 1.2),
    p(/(名字|地址|号码|密码|配置|设置|版本|账号|邮箱)/),
    p(/(多少|几个|哪个|哪些)/),
    p(/有没有/),
    p(/(是否|能不能|可不可以)/),
    p(/什么意思/),
    p(/怎么(用|装|配|设|弄)/, 1.2), // "how to use/install/configure"
  ],
  temporal: [
    // English
    p(/^(when|what time|how long)\b/i, 1.5),
    p(/(yesterday|today|tomorrow|last week|recently|ago|before|after)\b/i, 1.2),
    p(/(this morning|tonight|this week|last month|next)\b/i),
    p(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/, 1.5), // date patterns
    // Chinese - expanded
    p(/什么时候/, 1.5),
    p(/(昨天|今天|明天|前天|后天)/, 1.2),
    p(/(上周|这周|下周|上个月|这个月|下个月)/),
    p(/(最近|以前|之前|之后|刚才|刚刚)/),
    p(/(几月|几号|几点|几天|多久)/),
    p(/(早上|中午|下午|晚上|凌晨)/),
    p(/(第一次|上次|那次|每次)/),
    p(/\d+月\d+[日号]/, 1.5),
  ],
  causal: [
    // English
    p(/^(why|how come|what caused)\b/i, 1.5),
    p(/\b(because|due to|reason|caused by|result of)\b/i),
    p(/\b(lead to|consequence|therefore|thus)\b/i),
    // Chinese - expanded
    p(/为(什么|啥|何)/, 1.5),
    p(/(原因|因为|所以|导致|造成)/),
    p(/怎么(回事|了|会)/, 1.2),
    p(/(为啥|咋回事|咋了)/),
    p(/(结果|后果|影响)/),
    p(/(出了什么|发生了什么)/),
  ],
  exploratory: [
    // English
    p(/^(how|tell me about|explain|describe)\b/i, 1.2),
    p(/^(what do you think|what about|any)\b/i),
    p(/\b(overview|summary|example|compare|difference)\b/i),
    // Chinese - expanded
    p(/(怎么样|怎样)/, 1.2),
    p(/(介绍|说说|讲讲|聊聊)/),
    p(/(有哪些|有什么)/),
    p(/关于/, 1.2),
    p(/(总结|概述|对比|区别|比较)/),
    p(/(好不好|行不行|推荐)/),
    p(/(看看|想想|了解)/),
    p(/(经验|心得|总结|教训)/),
  ],
};

/**
 * Classify the intent of a search query.
 * Uses weighted keyword scoring with Chinese + English support.
 */
export function classifyIntent(query: string): IntentResult {
  const scores: Record<SearchIntent, number> = {
    factual: 0,
    exploratory: 0,
    temporal: 0,
    causal: 0,
  };

  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const { pattern, weight } of patterns) {
      if (pattern.test(query)) {
        scores[intent as SearchIntent] += weight;
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

  // Confidence: ratio of top score vs total, with minimum floor
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = totalScore > 0
    ? Math.min(0.95, 0.3 + (maxScore / totalScore) * 0.65) // range: 0.3 - 0.95
    : 0.5; // no signal → neutral confidence

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
