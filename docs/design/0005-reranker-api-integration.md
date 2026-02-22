# DD-0005: External Reranker API Integration (Qwen3-Reranker-8B)

**Status:** Draft
**Author:** Noah (Claude Opus)
**Date:** 2026-02-22
**Repo:** agent-memory

---

## 1. Background / 背景

agent-memory v2.1.0 的搜索流水线目前是：

```
BM25 (全文) ──┐
              ├── RRF 融合 ──→ 本地 rerank（priority/recency/vitality 加权）──→ 最终结果
Embedding 向量 ─┘
```

其中 `rerank.ts` 是一个**纯本地的数学加权函数**（优先级乘数 + 时间衰减 + 活力因子），它不理解语义。

我们刚刚成功接入了 Qwen3-Embedding-8B（通过 momo API），embedding 搜索已上线。但 momo 上同时提供了 **Qwen3-Reranker-8B**——一个 80 亿参数的交叉编码重排模型，能以 query-document pair 粒度做精读打分。

当前问题：RRF 融合后的候选列表质量已经不错，但最终排序仅靠本地数学公式，缺乏对 query↔document 的深层语义理解。接入外部 Reranker 可以在最终输出前再做一轮"精读"，大幅提升 Top-K 精度。

**已验证 API 可用性：**
```bash
POST https://momo.woshizhu.mom/v1/rerank
{
  "model": "Qwen/Qwen3-Reranker-8B",
  "query": "...",
  "documents": ["...", "..."]
}
# 返回: { "results": [{ "index": 0, "relevance_score": 0.xxx }, ...] }
```

---

## 2. Goals / 目标

- 在 `rerank.ts` 中增加可选的外部 Reranker API 调用，不破坏现有纯本地 rerank 逻辑
- 新增 `RerankProvider` 接口和 `getRerankerProviderFromEnv()` 工厂函数（类比现有的 `EmbeddingProvider`）
- 支持 OpenAI 兼容的 `/v1/rerank` 端点（Jina/Cohere/vLLM 风格），使其对 momo/自建 API 通用
- 在 `searchHybrid()` 或 MCP `recall` 工具中自动触发外部 rerank（当 provider 可用时）
- 通过环境变量配置（`AGENT_MEMORY_RERANK_PROVIDER`, `AGENT_MEMORY_RERANK_MODEL` 等），零代码可切换
- 保持 best-effort 原则：外部 reranker 不可用时，静默降级到本地 rerank，不中断搜索

---

## 3. Non-Goals / 非目标

- 不改变 BM25 / Embedding / RRF 融合逻辑
- 不实现批量 rerank（当前记忆条目少，逐次够用）
- 不支持流式 rerank
- 不改变 MCP 工具的对外 schema（`recall` 工具参数不变）
- 不引入新的数据库表或存储

---

## 4. Proposal / 方案

### 4.1 方案概述

在现有搜索流水线的最后一步（`rerank`），插入一个可选的外部 API 调用层：

```
BM25 ──┐                                         ┌── 外部 Reranker API ──┐
       ├── RRF 融合 ──→ 候选列表 (limit*2) ──→ │                        ├── 本地 rerank ──→ 最终结果
Embed ─┘                                          └── (不可用时跳过) ───┘
```

**核心思路：** 外部 reranker 替换候选列表的 score 值（用 `relevance_score`），然后本地 rerank 在新 score 基础上继续叠加 priority/vitality/recency 加权。这样既利用了 8B 参数的语义精读能力，又保留了我们独有的记忆优先级系统。

### 4.2 方案对比

| 维度 | 方案 A: 外部 rerank 替换 score | 方案 B: 外部 rerank 作为独立排序 |
|------|------|------|
| 复杂度 | 低——插入一步 score 替换 | 中——需要决定最终以谁的排序为准 |
| 与现有系统兼容 | ✅ 本地 rerank 逻辑完全保留 | ⚠️ 可能忽略 priority/vitality |
| 语义精度 | ✅ API score + 本地加权双重保障 | ✅ 纯 API score 精度最高但丢失 priority |

**选择方案 A**：外部 reranker 的 `relevance_score` 替换 RRF 融合后的 score，然后本地 rerank 继续叠加。

### 4.3 详细设计

#### 4.3.1 新增文件：`src/search/rerank-provider.ts`

```typescript
export interface RerankProvider {
  id: string;
  model: string;
  rerank(query: string, documents: string[]): Promise<RerankResult[]>;
}

export interface RerankResult {
  index: number;
  relevance_score: number;
}

export function getRerankerProviderFromEnv(): RerankProvider | null {
  const provider = (process.env.AGENT_MEMORY_RERANK_PROVIDER ?? "none").toLowerCase();
  if (provider === "none" || provider === "off") return null;

  if (provider === "openai" || provider === "jina" || provider === "cohere") {
    const apiKey = process.env.AGENT_MEMORY_RERANK_API_KEY
      ?? process.env.OPENAI_API_KEY; // 复用 embedding 的 key
    const model = process.env.AGENT_MEMORY_RERANK_MODEL ?? "Qwen/Qwen3-Reranker-8B";
    const baseUrl = process.env.AGENT_MEMORY_RERANK_BASE_URL
      ?? process.env.OPENAI_BASE_URL
      ?? "https://api.openai.com/v1";
    if (!apiKey) return null;
    return createOpenAIRerankProvider({ apiKey, model, baseUrl });
  }

  return null;
}

export function createOpenAIRerankProvider(opts: {
  apiKey: string;
  model: string;
  baseUrl?: string;
}): RerankProvider {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  return {
    id: "openai-rerank",
    model: opts.model,
    async rerank(query: string, documents: string[]) {
      const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/rerank`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: opts.apiKey.startsWith("Bearer ")
            ? opts.apiKey
            : `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({ model: opts.model, query, documents }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Rerank API failed: ${resp.status} ${body}`.trim());
      }
      const data = await resp.json() as {
        results?: Array<{ index: number; relevance_score: number }>
      };
      return (data.results ?? []).map(r => ({
        index: r.index,
        relevance_score: r.relevance_score,
      }));
    },
  };
}
```

#### 4.3.2 修改 `src/search/rerank.ts`

在现有 `rerank()` 函数之前新增一个异步的 `rerankWithProvider()` 函数：

```typescript
import type { RerankProvider } from "./rerank-provider.js";

export async function rerankWithProvider(
  results: SearchResult[],
  query: string,
  provider: RerankProvider,
): Promise<SearchResult[]> {
  if (results.length === 0) return results;

  const documents = results.map(r => r.memory.content);

  try {
    const apiResults = await provider.rerank(query, documents);
    // 用 API 的 relevance_score 替换原有 score
    const scoreMap = new Map(apiResults.map(r => [r.index, r.relevance_score]));
    return results.map((r, i) => ({
      ...r,
      score: scoreMap.get(i) ?? r.score, // fallback 到原 score
      matchReason: scoreMap.has(i)
        ? `${r.matchReason}+rerank`
        : r.matchReason,
    }));
  } catch (err) {
    // best-effort: 失败时静默降级
    console.warn("[agent-memory] External rerank failed, falling back:", err);
    return results;
  }
}
```

原有的同步 `rerank()` 函数**不做任何修改**。

#### 4.3.3 修改 `src/mcp/server.ts`

在 MCP server 初始化时加载 reranker provider：

```typescript
import { getRerankerProviderFromEnv } from "../search/rerank-provider.js";
import { rerankWithProvider } from "../search/rerank.js";

// 初始化
const rerankerProvider = getRerankerProviderFromEnv();

// recall 工具中，在本地 rerank 之前插入外部 rerank
async ({ query, limit }) => {
  const { intent, confidence } = classifyIntent(query);
  const strategy = getStrategy(intent);
  let raw = await searchHybrid(db, query, { ... });

  // 外部 reranker（可选）
  if (rerankerProvider) {
    raw = await rerankWithProvider(raw, query, rerankerProvider);
  }

  const results = rerank(raw, { ...strategy, limit });
  // ...
}
```

#### 4.3.4 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AGENT_MEMORY_RERANK_PROVIDER` | 否 | `"none"` | `"openai"` / `"jina"` / `"cohere"` / `"none"` |
| `AGENT_MEMORY_RERANK_MODEL` | 否 | `"Qwen/Qwen3-Reranker-8B"` | 模型名 |
| `AGENT_MEMORY_RERANK_API_KEY` | 否 | 继承 `OPENAI_API_KEY` | API 密钥 |
| `AGENT_MEMORY_RERANK_BASE_URL` | 否 | 继承 `OPENAI_BASE_URL` | API 端点 |

#### 4.3.5 导出

在 `src/index.ts` 中新增：

```typescript
export { getRerankerProviderFromEnv, createOpenAIRerankProvider, type RerankProvider, type RerankResult } from "./search/rerank-provider.js";
export { rerankWithProvider } from "./search/rerank.js";
```

---

## 5. Risks / 风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| API 超时/不可用 | 搜索变慢或失败 | best-effort + try/catch 降级到本地 rerank |
| API 费用 | 每次 recall 多一次 API 调用 | 仅在 provider 配置时启用；候选数量上限 20 |
| score 尺度不一致 | API relevance_score 和 BM25 score 量纲不同 | API score 直接替换，不做混合；本地 rerank 仅做乘法加权 |
| 增加延迟 | recall 多一个网络 round-trip | 记忆条目少（<100），payload 小，延迟可控 |

---

## 6. Test Plan / 测试方案

- [ ] Unit test: `rerank-provider.ts` — mock fetch 验证请求格式和响应解析
- [ ] Unit test: `rerankWithProvider()` — 正常路径 score 替换 + matchReason 追加
- [ ] Unit test: `rerankWithProvider()` — API 失败时静默降级，返回原始 results
- [ ] Unit test: `getRerankerProviderFromEnv()` — 各种环境变量组合
- [ ] Integration test: MCP recall 在有/无 reranker 时都能正常返回
- [ ] Manual verification: 对比有/无 reranker 时 Top-5 结果质量

---

## 7. Rollback Plan / 回滚方案

- 删除环境变量 `AGENT_MEMORY_RERANK_PROVIDER`（或设为 `none`）即可完全禁用，零影响
- 代码层面：`rerankWithProvider` 是独立函数，`rerank` 本身未被修改，删除新代码即可回滚

---

## 8. Decision Log / 决策变更记录

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-02-22 | 选择方案 A（API score 替换 + 本地加权叠加） | 保留 priority/vitality 系统的同时获得语义精读 |
| 2026-02-22 | Rerank API key 默认继承 OPENAI_API_KEY | 减少配置负担，momo 的 embedding 和 rerank 共用一个 key |

---

_Generated by DD workflow · Noah (Claude Opus)_
