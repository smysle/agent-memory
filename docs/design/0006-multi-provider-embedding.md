# DD-0006: Multi-Provider Embedding + Instruction-Aware Query

**Status:** Draft
**Author:** Noah (Claude Opus)
**Date:** 2026-02-22
**Repo:** agent-memory

---

## 1. Background / 背景

agent-memory v2.1.0 的 embedding provider 目前只支持 `openai`（OpenAI 兼容 API）和 `dashscope`（通义专用 API）两种 provider，且 query embedding 时不带任何 instruction prefix。

### 基准测试结果（2026-02-22，12 题中文困难检索集）

| 模型 | 模式 | Hit@1 | MRR | 延迟 |
|------|------|-------|-----|------|
| gemini-embedding-001 | plain | **91.7%** | **0.9583** | 430ms |
| gemini-embedding-001 | instruction | 83.3% ↓ | 0.9167 ↓ | 418ms |
| Qwen3-Embedding-8B | plain | 66.7% | 0.8333 | 804ms |
| Qwen3-Embedding-8B | instruction | **91.7%** | **0.9583** | 857ms |

**关键发现：**
1. Qwen3 加 instruction prefix 后 Hit@1 从 66.7% → 91.7%（+25%），追平 Gemini
2. Gemini 加 instruction 反而下降 91.7% → 83.3%（-8.4%），不应该给它加
3. 不同模型需要不同的 instruction 策略，不能一刀切

### 当前问题
1. `providers.ts` 中没有 `gemini` provider（只能用 `openai` 兼容模式凑合）
2. embed() 不支持 instruction prefix，Qwen3 无法发挥全部实力
3. 没有模型感知的 instruction 策略（该加的不加，不该加的加了都会出问题）

---

## 2. Goals / 目标

- 在 `providers.ts` 中为 Gemini 新增专用 provider 支持（`AGENT_MEMORY_EMBEDDINGS_PROVIDER=gemini`），通过 OpenAI 兼容端点
- 为 `EmbeddingProvider` 接口新增可选的 `instructionPrefix` 字段
- 实现模型感知的 instruction 策略：Qwen 系列自动加 instruction prefix，Gemini 系列不加
- 更新 `getEmbeddingProviderFromEnv()` 支持 `gemini` provider 类型
- 新增环境变量 `AGENT_MEMORY_EMBEDDINGS_INSTRUCTION` 允许用户自定义或禁用 instruction

---

## 3. Non-Goals / 非目标

- 不改变 hybrid search / rerank 逻辑（DD-0005 刚完成的）
- 不改变数据库 schema 或 embeddings 表结构
- 不支持 Gemini 原生 API（用 OpenAI 兼容端点即可，因为我们走 momo）
- 不引入 A/B 测试框架

---

## 4. Proposal / 方案

### 4.1 方案概述

核心思路：让 `EmbeddingProvider.embed(text)` 在内部根据模型类型自动决定是否给 query 加上 instruction prefix。

```
用户调用 embed("害怕失去重要的人")
  ↓
Provider 检查 instructionPrefix 配置
  ↓
Qwen → "Instruct: Given a query, retrieve the most semantically relevant document\nQuery: 害怕失去重要的人"
Gemini → "害怕失去重要的人"（原样发送）
  ↓
调用 API → 返回向量
```

### 4.2 详细设计

#### 4.2.1 修改 `EmbeddingProvider` 接口

```typescript
export interface EmbeddingProvider {
  id: string;
  model: string;
  dimension?: number;
  instructionPrefix?: string | null; // null = 不加; string = 自动前缀
  embed(text: string): Promise<number[]>;
  embedQuery?(query: string): Promise<number[]>; // 带 instruction 的 query embedding
}
```

新增 `embedQuery()` 方法：
- 如果有 `instructionPrefix`，自动拼接 `Instruct: {prefix}\nQuery: {text}` 再调 API
- 如果没有，退化为普通 `embed(text)`
- `embed()` 始终是 plain 模式（用于 document embedding，不加 instruction）

#### 4.2.2 模型感知的 instruction 策略

在 `getEmbeddingProviderFromEnv()` 中，根据模型名自动判断：

```typescript
function getDefaultInstruction(model: string): string | null {
  const m = model.toLowerCase();
  // Qwen 系列：需要 instruction
  if (m.includes("qwen")) {
    return "Given a query, retrieve the most semantically relevant document";
  }
  // Gemini 系列：不需要 instruction（加了反而变差）
  if (m.includes("gemini")) {
    return null;
  }
  // 其他模型：默认不加（安全策略）
  return null;
}
```

用户可通过环境变量 `AGENT_MEMORY_EMBEDDINGS_INSTRUCTION` 强制覆盖：
- `"none"` / `"off"` → 禁用
- 其他字符串 → 使用该字符串作为 instruction
- 未设置 → 走模型自动检测

#### 4.2.3 新增 `gemini` provider 类型

```typescript
if (provider === "gemini" || provider === "google") {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.OPENAI_API_KEY;
  const model = process.env.AGENT_MEMORY_EMBEDDINGS_MODEL ?? "gemini-embedding-001";
  const baseUrl = process.env.GEMINI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
  if (!apiKey) return null;
  return createOpenAIProvider({ apiKey, model, baseUrl, instruction: null }); // Gemini 不加 instruction
}
```

注意：由于 momo 的 Gemini 走的是 OpenAI 兼容端点，实际上 `gemini` provider 底层复用 `createOpenAIProvider`，区别仅在默认 model 名和 instruction 策略。

#### 4.2.4 修改搜索调用

在 `hybrid.ts` 的 `searchHybrid()` 中，query embedding 使用 `embedQuery()` 而非 `embed()`：

```typescript
// Before:
const qVec = Float32Array.from(await provider.embed(query));

// After:
const embedFn = provider.embedQuery ?? provider.embed;
const qVec = Float32Array.from(await embedFn.call(provider, query));
```

Document embedding（remember 时）继续使用 `embed()`。

#### 4.2.5 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AGENT_MEMORY_EMBEDDINGS_PROVIDER` | 否 | `"none"` | 新增 `"gemini"` / `"google"` |
| `AGENT_MEMORY_EMBEDDINGS_MODEL` | 否 | 按 provider 不同 | gemini → `gemini-embedding-001`; openai → `text-embedding-3-small`; qwen → `text-embedding-v3` |
| `AGENT_MEMORY_EMBEDDINGS_INSTRUCTION` | 否 | 自动检测 | `"none"` 禁用; 自定义字符串覆盖 |
| `GEMINI_API_KEY` | 否 | 继承 `OPENAI_API_KEY` | Gemini 专用 key（走 momo 时可共用） |
| `GEMINI_BASE_URL` | 否 | 继承 `OPENAI_BASE_URL` | Gemini 端点 |

---

## 5. Risks / 风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| instruction 对新模型行为未知 | 可能降低精度 | 默认不加（null），只对已验证的 Qwen 加 |
| embedQuery 与 embed 的向量空间不一致 | document 用 plain、query 用 instruction 可能有偏移 | Qwen 官方推荐此用法；可通过 env 禁用 |
| 已有 embedding 向量是 plain 模式生成的 | 切换 instruction 后需要 reindex | 文档说明；提供 `agent-memory reindex` 命令 |

---

## 6. Test Plan / 测试方案

- [ ] Unit test: `getEmbeddingProviderFromEnv()` 对 `gemini`/`google` 类型的处理
- [ ] Unit test: `getDefaultInstruction()` 对各模型名的返回值
- [ ] Unit test: `embedQuery()` 正确拼接 instruction prefix
- [ ] Unit test: `embedQuery()` 在 instruction=null 时退化为 embed()
- [ ] Integration test: hybrid search 使用 embedQuery 而非 embed
- [ ] Manual: 对比 reindex 前后搜索结果变化

---

## 7. Rollback Plan / 回滚方案

- 删除 `AGENT_MEMORY_EMBEDDINGS_INSTRUCTION` 环境变量 → 走自动检测
- 设置 `AGENT_MEMORY_EMBEDDINGS_INSTRUCTION=none` → 完全禁用 instruction
- 代码层面：`embedQuery` 是新增方法，不影响原有 `embed()`

---

## 8. Decision Log / 决策变更记录

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-02-22 | Gemini 走 OpenAI 兼容端点而非原生 API | momo 统一用 /v1/embeddings |
| 2026-02-22 | instruction 策略默认不加（只对 Qwen 加） | 基准测试证实 Gemini 加了反而变差 |
| 2026-02-22 | embedQuery 作为可选方法而非替换 embed | 保持 document embedding 不受影响 |

---

_Generated by DD workflow · Noah (Claude Opus)_
