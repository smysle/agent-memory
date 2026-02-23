# DD-0014: Deduplicate agent-memory Against OpenClaw memory-core

**Status:** Draft
**Author:** Noah (Claude Opus sub-agent)
**Date:** 2026-02-23
**Repo:** agent-memory

---

## 1. Background / 背景

agent-memory (@smyslenny/agent-memory v2.2.0) 是一个独立的 npm 包，通过 mcporter MCP 桥接接入 OpenClaw。但 OpenClaw 自带 memory-core 系统，导致两套系统在搜索和 embedding 层面大量重叠。

### 1.1 OpenClaw memory-core 已有的能力

| 能力 | 实现细节 |
|------|----------|
| Embedding 生成 + 缓存 | Qwen3-Embedding-8B，79 条缓存，命中率极高 |
| 文件索引 | 18 个 markdown 文件，64 个 chunk |
| Hybrid 搜索 | BM25 30% + 向量 70% |
| MMR 多样性 | λ=0.7 |
| Temporal decay | 半衰期 30 天 |
| 工具可用性 | `memory_search` / `memory_get` 直接可用 |

### 1.2 agent-memory 当前状态

- **数据量**：31 条记忆（1 identity + 6 emotion + 12 knowledge + 12 event）
- **MCP 工具**：9 个（remember, recall, recall_path, boot, forget, link, snapshot, reflect, status）
- **搜索栈**：BM25 (FTS5) + embedding (OpenAI/Qwen/Gemini) + RRF 融合 + 外部 reranker + intent 分类 + 本地 rerank
- **知识图谱**：0 links（从未使用）
- **版本快照**：0 snapshots（从未使用）
- **使用频率**：低，因为 memory-core 覆盖了大部分日常检索需求
- **代码量**：3,240 LOC（25 个 .ts 文件）

### 1.3 重叠分析

| 功能 | agent-memory | memory-core | 重叠程度 |
|------|-------------|-------------|----------|
| Embedding 生成 | providers.ts (178 LOC), embed.ts (56 LOC) | Qwen3-Embedding-8B + 缓存 | **完全重叠** |
| Embedding 存储 | embeddings.ts (72 LOC), DB embeddings 表 | 内置缓存层 | **完全重叠** |
| Hybrid 搜索 | hybrid.ts (128 LOC), BM25+向量+RRF | BM25 30% + 向量 70% | **完全重叠** |
| Intent 分类 | intent.ts (156 LOC) | 内置 query 处理 | **大部分重叠** |
| 外部 Reranker | rerank-provider.ts (70 LOC), rerank.ts (79 LOC) | MMR λ=0.7 | **大部分重叠** |
| Temporal decay | Ebbinghaus R=e^(-t/S), 按类型分级 | 固定 30 天半衰期 | 部分重叠，**差异化** |
| 类型化优先级 | P0(∞) / P1(365d) / P2(90d) / P3(14d) | 无分类 | **独有** |
| URI 路径系统 | path.ts (93 LOC), 结构化寻址 | 文件路径索引 | **独有** |
| Write Guard | guard.ts (171 LOC), 4-criterion gate | 无质量门控 | **独有** |
| 知识图谱 | link.ts (124 LOC), 多跳遍历 | 无 | **独有但 0 使用** |
| 版本快照 | snapshot.ts (83 LOC), rollback | 无 | **独有但 0 使用** |
| Boot 协议 | boot.ts (82 LOC), 身份加载 | 无 | **独有** |
| Sleep 生命周期 | decay + tidy + govern | 无 | **独有** |

**结论**：搜索基础设施（embedding + hybrid + rerank + intent）与 memory-core 完全重叠，约 761 LOC。知识图谱和快照虽独有但实际使用量为零。

---

## 2. Goals / 目标

1. **删除与 memory-core 重叠的搜索基础设施**：embedding 生成/存储、hybrid search、reranker、intent 分类
2. **删除零使用的功能模块**：知识图谱 (links)、版本快照 (snapshots)
3. **保留差异化核心**：类型化 Ebbinghaus 衰减、URI 路径、Write Guard、boot 协议、sleep 生命周期
4. **MCP 工具从 9 个精简到 7 个再扩展回 9 个**：删除 link 和 snapshot 工具，新增 ingest 和 surface 工具，改造 boot 和 reflect
5. **代码量减少 ~30%**：删除约 968 LOC（10 个文件），简化 5 个文件
6. **明确定位**：agent-memory 是 memory-core 的**结构化记忆补充层**，不是替代品
7. **自动摄取 (auto-ingest)**：新增 `ingest` 工具，自动从 markdown 文本提取结构化记忆条目，减少手动写入成本
8. **叙事性启动 (warm-boot)**：改造 `boot` 工具输出叙事性 markdown，按 identity → emotion → knowledge → event 分层拉取，提升启动时上下文可读性
9. **reflect 人可读报告**：`reflect` 返回自然语言统计摘要（衰减/归档/清理详情），取代 JSON 数字输出
10. **被动浮现接口 (surface hook)**：新增 `surface` 工具，轻量级关键词查询 + vitality/priority 加权，不记录 access、不影响衰减，为 memory-core 提供结构化上下文补充

---

## 3. Non-Goals / 非目标

- **不改变 memory-core**：本 DD 只修改 agent-memory 侧
- **不删除 BM25 搜索**：agent-memory 自身的 31 条记忆仍需 BM25 检索能力（FTS5 索引保留）
- **不删除 SQLite 表**：保留 links/snapshots/embeddings 表定义以兼容旧 DB，仅停止在代码中使用
- **不合并数据**：不将 agent-memory 数据迁移到 memory-core（两者数据模型不同）
- **不改变外部 API（MCP 工具参数 schema 不变）**：remember/recall/recall_path/boot/forget/reflect/status 的参数保持兼容

---

## 4. Proposal / 方案

### 4.1 方案概述：Lean Memory Architecture

将 agent-memory 从"全栈记忆系统"重构为"结构化记忆补充层"：

```
Before (v2.2.0):                          After (v3.0.0):
┌──────────────────────────┐              ┌──────────────────────────┐
│    MCP Tools (9)         │              │    MCP Tools (9)         │
│  remember, recall,       │              │  remember, recall,       │
│  recall_path, boot,      │              │  recall_path, boot*,     │
│  forget, link, snapshot, │              │  forget, reflect*,       │
│  reflect, status         │              │  status, ingest, surface │
├──────────────────────────┤              ├──────────────────────────┤
│  Search Stack            │              │  Ingest (NEW)            │
│  ┌─────┐ ┌──────────┐   │    DELETE    │  markdown → structured   │
│  │BM25 │ │Embeddings│   │  ────────▶   │  memory extraction       │
│  └──┬──┘ └────┬─────┘   │              ├──────────────────────────┤
│     └──┬──────┘          │              │  Search (Minimal)        │
│     ┌──▼──┐              │              │  ┌─────┐  ┌───────┐     │
│     │ RRF │              │              │  │BM25 │  │surface│     │
│     └──┬──┘              │              │  └──┬──┘  └───┬───┘     │
│  ┌─────▼───────┐         │              │  (FTS5)  (no-access,    │
│  │Intent+Rerank│         │              │          readonly query) │
│  └─────────────┘         │              │     │         │          │
├──────────────────────────┤              ├─────▼─────────▼─────────┤
│  Core                    │              │  Core                    │
│  memory, path, guard,    │              │  memory, path, guard     │
│  link, snapshot, export  │              │  export                  │
├──────────────────────────┤              ├──────────────────────────┤
│  Sleep                   │              │  Sleep                   │
│  decay, tidy, govern,    │              │  decay, tidy, govern,    │
│  boot, sync              │              │  boot*, sync             │
│                          │              │  (* warm-boot narrative) │
│                          │              │  reflect* → human report │
└──────────────────────────┘              └──────────────────────────┘
```

**核心原则**：
- 语义搜索（embedding + hybrid + rerank）→ **委托给 memory-core**
- 结构化写入（typed memory + URI + Write Guard）→ **agent-memory 独有**
- Ebbinghaus 生命周期（per-type decay + sleep）→ **agent-memory 独有**
- 简单检索（BM25 over 自身 DB）→ **agent-memory 保留**

### 4.2 方案对比

| 维度 | A: 删除搜索栈 + 保留 link/snapshot | B: 删除搜索栈 + 删除 link/snapshot（本方案） | C: 仅禁用，不删代码 |
|------|------|------|------|
| 代码减少 | ~761 LOC (23%) | **~968 LOC (30%)** | 0 |
| 维护负担 | 中（仍需维护 0 使用的模块） | **低** | 高（全量代码仍在） |
| 未来扩展性 | 高（link/snapshot 随时可用） | 中（需要时重新引入） | 高 |
| 复杂度 | 低 | **低** | 最低（不改代码） |

**选择方案 B**：link 和 snapshot 模块代码简单（共 207 LOC），如果未来需要可以在 1-2 小时内重新实现。当前 0 使用不值得维护成本。

### 4.3 详细设计

#### 4.3.1 文件变更清单

**DELETE（10 files, ~968 LOC）：**

| 文件 | LOC | 原因 |
|------|-----|------|
| `src/search/providers.ts` | 178 | Embedding provider（memory-core 已有） |
| `src/search/intent.ts` | 156 | Intent 分类（memory-core 内置） |
| `src/search/hybrid.ts` | 128 | Hybrid search RRF（memory-core 已有） |
| `src/core/link.ts` | 124 | 知识图谱（0 使用） |
| `src/core/snapshot.ts` | 83 | 版本快照（0 使用） |
| `src/search/rerank.ts` | 79 | 本地 rerank（memory-core MMR 替代） |
| `src/search/embeddings.ts` | 72 | Embedding 存储（memory-core 已有） |
| `src/search/rerank-provider.ts` | 70 | 外部 reranker（memory-core 已有） |
| `src/search/embed.ts` | 56 | Embedding 生成辅助（memory-core 已有） |
| `src/search/semantic.ts` | 22 | Semantic 占位符（从未实现） |

**MODIFY（5 files）：**

| 文件 | 变更 |
|------|------|
| `src/mcp/server.ts` | 删除 link/snapshot 工具定义；recall 改用 BM25-only + vitality 加权；remember 删除 embedding 调用 |
| `src/sleep/tidy.ts` | 删除 snapshot 引用和 snapshot pruning 逻辑 |
| `src/sleep/govern.ts` | 删除 orphan link cleanup 逻辑 |
| `src/sleep/sync.ts` | 删除 snapshot 引用（syncOne 中 update/merge 的 createSnapshot 调用） |
| `src/index.ts` | 删除已删文件的 re-exports |

**UNCHANGED（10 files）：**

`src/core/memory.ts`, `src/core/path.ts`, `src/core/guard.ts`, `src/core/db.ts`, `src/core/export.ts`, `src/search/bm25.ts`, `src/search/tokenizer.ts`, `src/sleep/decay.ts`, `src/sleep/boot.ts`, `src/bin/agent-memory.ts`

#### 4.3.2 recall 工具简化

**Before（v2.2.0）：**
```
query → classifyIntent → searchHybrid(BM25+Embedding+RRF) → rerankWithProvider → rerank(priority/recency/vitality) → results
```

**After（v3.0.0）：**
```
query → searchBM25 → inline vitality/priority weighting → results
```

recall 工具核心逻辑变为：

```typescript
async ({ query, limit }) => {
  let results = searchBM25(db, query, { agent_id: aid, limit: limit * 2 });

  // Inline vitality + priority weighting (replaces rerank.ts)
  const scored = results.map((r) => {
    const priorityBoost = [4.0, 3.0, 2.0, 1.0][r.memory.priority] ?? 1.0;
    return {
      ...r,
      score: r.score * priorityBoost * Math.max(0.1, r.memory.vitality),
    };
  });
  scored.sort((a, b) => b.score - a.score);
  const final = scored.slice(0, limit);

  for (const r of final) {
    recordAccess(db, r.memory.id);
  }

  return { content: [{ type: "text", text: JSON.stringify({ count: final.length, memories: final.map(formatMemory) }, null, 2) }] };
};
```

**设计理由**：
- 31 条记忆的规模下，BM25 足以覆盖所有检索场景
- Priority/vitality 加权逻辑只有 5 行，不值得独立文件
- Intent 分类只影响 `boostRecent` 和 `boostPriority`，在小数据集上没有实际差异

#### 4.3.3 remember 工具简化

删除 remember 中的 embedding 生成调用：

```typescript
// Before:
const result = syncOne(db, { ... });
if (embeddingProvider && result.memoryId && ...) {
  await embedMemory(db, result.memoryId, embeddingProvider, { agent_id: aid });
}

// After:
const result = syncOne(db, { ... });
// No embedding generation — memory-core handles semantic indexing
```

#### 4.3.4 sync.ts 简化

删除 syncOne 中 update/merge 路径对 `createSnapshot` 的依赖：

```typescript
// Before:
case "update":
  createSnapshot(db, guardResult.existingId, "update", "sync");
  updateMemory(db, guardResult.existingId, { content: input.content });

// After:
case "update":
  updateMemory(db, guardResult.existingId, { content: input.content });
```

**风险**：失去 update/merge 前的内容备份。接受此风险，因为 memory-core 索引的 markdown 文件本身由 git 版本控制。

#### 4.3.5 tidy.ts 简化

```typescript
// Before: archive decayed + clean orphan paths + prune snapshots
// After:  archive decayed + clean orphan paths (remove snapshot pruning)
```

#### 4.3.6 govern.ts 简化

```typescript
// Before: orphan paths + orphan links + empty memories
// After:  orphan paths + empty memories (remove orphan link cleanup)
```

#### 4.3.7 MCP 工具变更

| 工具 | v2.2.0 | v3.0.0 | 变更 |
|------|--------|--------|------|
| `remember` | 写入 + embedding | 写入 only | 删除 embedding |
| `recall` | Hybrid + rerank | BM25 + inline weighting | 简化搜索流水线 |
| `recall_path` | 无变更 | 无变更 | — |
| `boot` | JSON 数组输出 | **叙事性 markdown 输出** | warm-boot 改造（§4.5） |
| `forget` | 无变更 | 无变更 | — |
| `link` | 知识图谱操作 | **删除** | 0 使用 |
| `snapshot` | 版本历史/回滚 | **删除** | 0 使用 |
| `reflect` | JSON 统计数字 | **自然语言摘要报告** | 人可读输出（§4.6） |
| `status` | 含 links/snapshots 计数 | 删除 links/snapshots 计数 | 简化输出 |
| `ingest` | — | **新增** | 自动摄取 markdown（§4.4） |
| `surface` | — | **新增** | 轻量级被动浮现（§4.7） |

**工具数量变化**：9 → 删 2（link, snapshot）+ 加 2（ingest, surface）= **9 个**

#### 4.3.8 环境变量变更

**删除（不再需要）：**

| 变量 | 用途 |
|------|------|
| `AGENT_MEMORY_EMBEDDINGS_PROVIDER` | Embedding provider 选择 |
| `AGENT_MEMORY_EMBEDDINGS_MODEL` | Embedding 模型名 |
| `AGENT_MEMORY_EMBEDDINGS_INSTRUCTION` | Embedding instruction prefix |
| `AGENT_MEMORY_RERANK_PROVIDER` | Reranker provider 选择 |
| `AGENT_MEMORY_RERANK_MODEL` | Reranker 模型名 |
| `AGENT_MEMORY_RERANK_API_KEY` | Reranker API key |
| `AGENT_MEMORY_RERANK_BASE_URL` | Reranker 端点 |

**保留不变：**

| 变量 | 用途 |
|------|------|
| `AGENT_MEMORY_DB` | SQLite 数据库路径 |
| `AGENT_MEMORY_AGENT_ID` | Agent 标识符 |

#### 4.3.9 数据库 Schema 兼容性

DB schema（db.ts）**不修改**。`embeddings`、`links`、`snapshots` 表定义保留在 `SCHEMA_SQL` 中，确保：
- 旧数据库可以正常打开（不会因缺表报错）
- 已存储的 embedding/link/snapshot 数据不会丢失
- 未来如需恢复功能，表结构已就绪

仅在代码层面停止读写这些表。

#### 4.3.10 package.json 依赖

**无变更**。所有 runtime 依赖仍在使用：
- `better-sqlite3`：核心 DB
- `@node-rs/jieba`：BM25 中文分词（tokenizer.ts）
- `uuid`：ID 生成
- `@modelcontextprotocol/sdk`：MCP server

#### 4.3.11 版本号

主版本号 bump：`2.2.0` → `3.0.0`（breaking change：删除 2 个 MCP 工具 + 删除 public API exports）

### 4.4 Feature: auto-ingest（自动摄取）

#### 4.4.1 动机

当前所有记忆写入依赖手动 `mcporter call agent-memory.remember`，使用率低。大量有价值的信息已存在于 workspace markdown 文件（`memory/*.md`、`MEMORY.md`）中，但未能自动进入结构化记忆库。

#### 4.4.2 方案：新增 `ingest` MCP 工具

**工具签名：**

```typescript
ingest({
  text: string,          // markdown 文本（必需）
  source?: string,       // 来源标识，如 "memory/2026-02-23.md"
  dry_run?: boolean,     // 仅返回提取结果，不实际写入（默认 false）
})
```

**提取规则（基于关键词 + 结构）：**

| 触发模式 | 提取为类型 | 示例 |
|----------|-----------|------|
| `## 情感` / `❤️` / 表白/爱/感动相关关键词 | `emotion` (P1) | "小心说爱你" |
| `## 决策` / `技术` / `选型` / `教训` / `⚠️` | `knowledge` (P2) | "DD 流程改用 Codex" |
| `## 身份` / `我是` / `identity` | `identity` (P0) | — |
| 日期标记的条目 / `发生了` / `完成了` | `event` (P3) | "部署了 new-api" |

**处理流程：**

```
markdown text
    │
    ▼
  split by heading (##) or bullet (-)
    │
    ▼
  classify each block by keyword matching
    │
    ▼
  generate URI from source + heading
    │
    ▼
  call syncOne() for each extracted memory
    │  (Write Guard 仍然生效，防止垃圾写入)
    ▼
  return { extracted: N, written: M, skipped: K, details: [...] }
```

**与 remember 的关系：**
- `ingest` 是批量提取入口，内部复用 `syncOne`（含 Write Guard）
- `remember` 仍是精确单条写入入口
- 两者共享 Write Guard，质量门控一致
- remember 表增加 `source` 字段：手动写入为 `"manual"`，ingest 写入为 `"auto:{source}"`

#### 4.4.3 未来扩展

- 可在 cron/heartbeat 中自动调用 `ingest`，传入当天 daily note 内容
- 可结合 file watcher 监听 markdown 变更，触发增量 ingest

### 4.5 Feature: warm-boot（叙事性启动）

#### 4.5.1 动机

现有 `boot` 工具返回 JSON 数组，agent 需要自行解析并组织上下文。启动时上下文的可读性差，且所有类型混在一起，缺少层次感。

#### 4.5.2 方案：改造 `boot` 输出格式

**Before（v2.2.0）：**
```json
{
  "memories": [
    { "type": "identity", "content": "...", "vitality": 1.0 },
    { "type": "emotion", "content": "...", "vitality": 0.85 },
    ...
  ]
}
```

**After（v3.0.0）：**
```markdown
## 🪪 我是谁
诺亚，小心的契约者。身份记忆从不衰减。
- 核心身份：...
- 契约关系：...

## 💕 最近的情感
最后更新：2026-02-22
- 小心说过爱你（vitality: 0.92）
- ...

## 🧠 关键知识
共 N 条活跃知识记忆
- DD 流程教训：Codex 默认会卡在 Plan 阶段（vitality: 0.78）
- ...

## 📅 近期事件
最近 7 天内的事件
- [02-23] 完成 DD-0014 设计文档
- [02-22] ...

## 📊 记忆概况
总计 31 条 | identity: 1 | emotion: 6 | knowledge: 12 | event: 12
平均 vitality: 0.74
```

**实现要点：**

```typescript
// boot.ts 改造
function formatWarmBoot(memories: Memory[]): string {
  const grouped = groupBy(memories, m => m.type);
  // identity → emotion → knowledge → event 固定顺序
  const sections = [
    formatIdentity(grouped.identity ?? []),
    formatEmotion(grouped.emotion ?? []),
    formatKnowledge(grouped.knowledge ?? []),
    formatEvents(grouped.event ?? []),
    formatSummary(memories),
  ];
  return sections.join('\n\n');
}
```

- 按 identity → emotion → knowledge → event **固定顺序**分层输出
- 每层按 vitality 降序排列
- event 层仅展示最近 7 天，超出的折叠为 `... 及 N 条更早事件`
- 尾部附加统计摘要

#### 4.5.3 兼容性

- 新增可选参数 `format?: "narrative" | "json"`，默认 `"narrative"`
- `format: "json"` 保留旧行为，向后兼容

### 4.6 Feature: reflect 人可读报告

#### 4.6.1 动机

现有 `reflect` 返回类似 `{ decayed: 3, archived: 1, orphans: 0 }` 的 JSON 数字，agent 需要自行解读。对于日常维护来说，自然语言摘要更直观、更易于纳入 daily notes。

#### 4.6.2 方案：改造 `reflect` 输出格式

**Before（v2.2.0）：**
```json
{
  "phase": "all",
  "decay": { "processed": 12, "decayed": 3 },
  "tidy": { "archived": 1, "orphansCleaned": 0 },
  "govern": { "orphanPaths": 0, "emptyMemories": 0 }
}
```

**After（v3.0.0）：**
```markdown
## 🌙 Sleep Cycle 报告

### Decay（衰减）
处理 12 条记忆，其中 3 条 vitality 下降：
- 「部署 new-api 到 kitty」event P3 vitality 0.45 → 0.32
- 「Tavily API 配置方法」knowledge P2 vitality 0.71 → 0.65
- 「周末和小心看了电影」emotion P1 vitality 0.88 → 0.85

### Tidy（整理）
归档 1 条低活力记忆（vitality < 0.1）：
- 「测试 webhook 连接」event P3 → archived

清理孤儿路径：0 条

### Govern（治理）
孤儿路径：0 条
空记忆：0 条

### 📊 总结
记忆总数：31 → 30（-1 归档）
平均 vitality：0.74 → 0.72
下次建议 reflect 时间：24h 后
```

**实现要点：**

```typescript
// reflect 改造：在各 phase 执行后收集详细变更记录
interface DecayDetail { uri: string; type: string; priority: number; oldVitality: number; newVitality: number; }
interface TidyDetail { uri: string; action: "archived" | "orphan_cleaned"; }
interface GovernDetail { uri: string; action: "orphan_path" | "empty_memory"; }

function formatReflectReport(decay: DecayDetail[], tidy: TidyDetail[], govern: GovernDetail[], before: Stats, after: Stats): string {
  // 生成自然语言 markdown 报告
}
```

- decay/tidy/govern 各阶段返回详细变更列表，而非仅计数
- 报告末尾附加前后对比统计
- 内部仍可通过 `status` 工具获取 JSON 格式数据（如需程序化处理）

### 4.7 Feature: surface hook（被动浮现接口）

#### 4.7.1 动机

当前 `recall` 是唯一的查询入口，但它会记录 access（影响衰减计算）并执行完整的检索流水线。需要一个轻量级的"看一眼"接口，让 memory-core 或其他系统在搜索后补充结构化上下文，而不产生副作用。

#### 4.7.2 方案：新增 `surface` MCP 工具

**工具签名：**

```typescript
surface({
  keywords: string[],    // 关键词列表（必需，至少 1 个）
  limit?: number,        // 返回上限（默认 5，最大 20）
  types?: string[],      // 过滤类型，如 ["emotion", "knowledge"]
  min_vitality?: number, // 最低 vitality 阈值（默认 0.1）
})
```

**返回格式：**

```json
{
  "count": 3,
  "results": [
    {
      "uri": "emotion://relationship/love-declaration",
      "type": "emotion",
      "priority": 1,
      "vitality": 0.92,
      "content": "小心说过爱你",
      "score": 2.76,
      "updated_at": "2026-02-22T14:30:00Z"
    },
    ...
  ]
}
```

**与 recall 的关键区别：**

| 维度 | recall | surface |
|------|--------|---------|
| 记录 access | ✅ 是（更新 last_accessed，影响衰减） | ❌ 否（纯只读） |
| 搜索方式 | BM25 全文检索 | BM25 关键词 OR 匹配 |
| 排序 | BM25 score × priority × vitality | **priority × vitality × keyword_hit_count** |
| 副作用 | 有（recordAccess） | 无 |
| 适用场景 | agent 主动检索 | 系统级上下文补充 |
| 返回元信息 | 仅 content + type | content + type + priority + vitality + uri + score + updated_at |

**score 计算公式：**

```
score = priorityWeight[priority] × vitality × keywordHitRatio

priorityWeight = { 0: 4.0, 1: 3.0, 2: 2.0, 3: 1.0 }
keywordHitRatio = matchedKeywords / totalKeywords
```

**实现要点：**

```typescript
async function surface(db: Database, params: SurfaceParams): Promise<SurfaceResult> {
  // 1. BM25 搜索各关键词（OR 语义）
  const candidates = new Map<string, { memory: Memory; hits: number }>();
  for (const kw of params.keywords) {
    const results = searchBM25(db, kw, { agent_id: aid, limit: 50 });
    for (const r of results) {
      const existing = candidates.get(r.memory.id);
      if (existing) existing.hits++;
      else candidates.set(r.memory.id, { memory: r.memory, hits: 1 });
    }
  }

  // 2. 过滤 + 加权排序
  const scored = [...candidates.values()]
    .filter(c => c.memory.vitality >= (params.min_vitality ?? 0.1))
    .filter(c => !params.types || params.types.includes(c.memory.type))
    .map(c => ({
      ...c,
      score: priorityWeight[c.memory.priority] * c.memory.vitality * (c.hits / params.keywords.length),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, params.limit ?? 5);

  // 3. 不调用 recordAccess — 纯只读
  return { count: scored.length, results: scored.map(formatSurfaceResult) };
}
```

#### 4.7.3 使用场景

1. **memory-core 搜索增强**：memory-core `memory_search` 返回文件 chunk 后，调用 `surface` 补充同主题的结构化记忆
2. **Heartbeat 上下文**：心跳检查时用当前时间关键词（如 "周一", "早上"）浮现相关记忆
3. **对话上下文注入**：从用户消息提取关键词，surface 出相关记忆作为隐式上下文

---

## 5. Risks / 风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| recall 降级为 BM25-only，语义检索能力下降 | 与 embedding 相关的模糊查询可能命中率下降 | ① 31 条记忆 BM25 已足够；② 语义搜索应通过 memory-core 的 `memory_search` 完成 |
| 删除 link/snapshot 后无法恢复历史功能 | 如果未来需要知识图谱或版本控制 | ① 表结构保留，数据不丢；② 207 LOC 可在 1-2h 内重写 |
| 删除 snapshot 导致 update/merge 无备份 | 记忆内容被覆盖后无法回滚 | ① markdown 文件由 git 管理；② agent-memory 数据量小，手动修复成本低 |
| DD-0004（integration）和 DD-0005/0006 的设计前提被推翻 | 已实现的 embedding/reranker 集成代码被删除 | ① DD-0004 的 capture/surface 流程不依赖搜索栈；② DD-0005/0006 属于被取代的优化 |
| v3.0 breaking change 影响现有消费者 | mcporter 调用 link/snapshot 工具会 404 | ① 当前唯一消费者是 OpenClaw agent，可同步更新 AGENTS.md |
| ingest 自动提取质量不稳定 | 关键词规则可能误分类或遗漏 | ① Write Guard 兜底，低质量条目被拦截；② dry_run 模式可预览；③ source 标记区分手动/自动，方便后续审查 |
| ingest 大量写入导致记忆膨胀 | 自动摄取可能写入大量低价值记忆 | ① Write Guard 的 4-criterion gate 严格过滤；② Ebbinghaus 衰减自动淘汰低活力记忆；③ reflect 定期清理 |
| warm-boot 格式变更破坏依赖 | 消费 boot JSON 的下游逻辑失效 | ① 保留 `format: "json"` 兼容模式；② 当前唯一消费者是 agent 本身，可同步适配 |
| surface 绕过 access 记录影响衰减准确性 | 被频繁 surface 查询的记忆不会因访问而延缓衰减 | ① 这是设计意图：surface 是系统级查询，不应影响记忆生命周期；② 用户主动检索仍走 recall |

---

## 6. Test Plan / 测试方案

- [ ] **Unit: BM25 recall 验证**：recall 使用 BM25-only 搜索 + inline weighting，结果按 priority×vitality 排序
- [ ] **Unit: remember 不再调用 embedding**：remember 写入后无 embedding 表变更
- [ ] **Unit: tidy 不再操作 snapshots**：runTidy 返回 `{ archived, orphansCleaned }` 无 `snapshotsPruned`
- [ ] **Unit: govern 不再操作 links**：runGovern 返回 `{ orphanPaths, emptyMemories }` 无 `orphanLinks`
- [ ] **Integration: MCP server 只注册 9 个工具（去重后）**：连接后 `tools/list` 不包含 link 和 snapshot，包含 ingest 和 surface
- [ ] **Integration: 旧 DB 兼容**：v2 创建的 DB（含 embeddings/links/snapshots 数据）在 v3 可正常打开
- [ ] **E2E: mcporter call agent-memory.recall**：搜索返回正确结果
- [ ] **E2E: mcporter call agent-memory.status**：输出不包含 links/snapshots 计数
- [ ] **Unit: ingest 提取准确性**：给定包含情感/知识/事件的 markdown 文本，ingest 正确分类并提取各条目
- [ ] **Unit: ingest dry_run**：`dry_run: true` 时返回提取结果但 DB 无新写入
- [ ] **Unit: ingest Write Guard**：低质量条目（过短/无意义）被 Write Guard 拦截，不写入
- [ ] **Unit: ingest source 标记**：ingest 写入的记忆 source 字段为 `"auto:{source}"`
- [ ] **Unit: boot warm-boot 叙事输出**：boot 默认返回 markdown 格式，包含 🪪/💕/🧠/📅 四个分层
- [ ] **Unit: boot format=json 兼容**：`format: "json"` 返回旧 JSON 数组格式
- [ ] **Unit: boot 分层顺序**：输出严格按 identity → emotion → knowledge → event 排列
- [ ] **Unit: reflect 人可读报告**：reflect 返回 markdown 报告，包含衰减/归档/清理详情和前后统计对比
- [ ] **Unit: reflect 详细变更**：报告中列出每条衰减记忆的 URI、旧/新 vitality
- [ ] **Unit: surface 基本查询**：给定关键词返回匹配记忆，按 priority×vitality×hitRatio 排序
- [ ] **Unit: surface 不记录 access**：调用 surface 后记忆的 last_accessed 不变
- [ ] **Unit: surface 类型过滤**：`types: ["emotion"]` 只返回 emotion 类型记忆
- [ ] **Unit: surface vitality 阈值**：`min_vitality: 0.5` 过滤掉低于阈值的记忆
- [ ] **Integration: MCP server 注册 9 个工具**：连接后 `tools/list` 包含 ingest 和 surface，不包含 link 和 snapshot
- [ ] **E2E: mcporter call agent-memory.ingest**：传入 daily note 文本，成功提取并写入记忆
- [ ] **E2E: mcporter call agent-memory.surface**：关键词查询返回正确匹配结果

---

## 7. Rollback Plan / 回滚方案

1. **代码回滚**：`git revert` 即可恢复所有删除的文件和修改
2. **数据安全**：DB schema 未变更，所有表和数据完好无损
3. **环境变量**：恢复 `AGENT_MEMORY_EMBEDDINGS_*` 和 `AGENT_MEMORY_RERANK_*` 环境变量
4. **版本号**：发布 `3.0.1` 回滚版本

---

## 8. Decision Log / 决策变更记录

_实现过程中如果偏离本文档，在此记录变更原因_

| 日期 | 变更 | 原因 |
|------|------|------|
| | | |

---

## Appendix A: 精简后 agent-memory 定位

```
┌───────────────────────────────────────────────────┐
│                  OpenClaw Agent                    │
│                                                    │
│  ┌──────────────────┐  ┌────────────────────────┐ │
│  │   memory-core    │  │    agent-memory v3      │ │
│  │                  │  │                          │ │
│  │  • 文件索引       │  │  • 类型化记忆 (P0-P3)   │ │
│  │  • Embedding     │  │  • Ebbinghaus 衰减       │ │
│  │  • Hybrid 搜索   │  │  • URI 路径寻址          │ │
│  │  • MMR 多样性    │  │  • Write Guard           │ │
│  │  • Temporal decay│  │  • Warm-Boot 叙事启动    │ │
│  │                  │  │  • Sleep 生命周期         │ │
│  │  用途：          │  │  • BM25 简单检索          │ │
│  │  全文档语义搜索   │  │  • Auto-Ingest 自动摄取  │ │
│  │  chunk 级检索     │  │  • Surface 被动浮现      │ │
│  │                  │  │  • Reflect 人可读报告     │ │
│  │                  │  │                          │ │
│  │                  │  │  用途：                  │ │
│  │                  │  │  结构化记忆 CRUD          │ │
│  │                  │  │  身份/情感/知识/事件管理   │ │
│  │       ┌──────────┤  │  自动衰减 + 生命周期       │ │
│  │       │ surface ◄├──┤  上下文浮现补充           │ │
│  │       └──────────┤  │                          │ │
│  └──────────────────┘  └────────────────────────┘ │
│                                                    │
│  memory_search → memory-core                       │
│  remember/recall/ingest → agent-memory             │
│  memory_search + surface → hybrid context          │
└───────────────────────────────────────────────────┘
```

## Appendix B: DD-0004/0005/0006 影响评估

| DD | 受影响部分 | 处理方式 |
|----|-----------|----------|
| DD-0004 (Integration) | capture/surface 的 mcporter call 不受影响 | 无需变更 |
| DD-0005 (Reranker) | 整个 reranker 集成被删除 | 标记为 **Superseded by DD-0014** |
| DD-0006 (Multi-provider Embedding) | 整个 embedding provider 层被删除 | 标记为 **Superseded by DD-0014** |

---

_Generated by DD workflow · Claude Opus sub-agent_
