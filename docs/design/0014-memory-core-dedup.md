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
4. **MCP 工具从 9 个精简到 7 个**：删除 link 和 snapshot 工具，recall 降级为 BM25-only
5. **代码量减少 ~30%**：删除约 968 LOC（10 个文件），简化 5 个文件
6. **明确定位**：agent-memory 是 memory-core 的**结构化记忆补充层**，不是替代品

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
│    MCP Tools (9)         │              │    MCP Tools (7)         │
│  remember, recall,       │              │  remember, recall,       │
│  recall_path, boot,      │              │  recall_path, boot,      │
│  forget, link, snapshot, │              │  forget, reflect, status │
│  reflect, status         │              │                          │
├──────────────────────────┤              ├──────────────────────────┤
│  Search Stack            │              │  Search (Minimal)        │
│  ┌─────┐ ┌──────────┐   │    DELETE    │  ┌─────┐                 │
│  │BM25 │ │Embeddings│   │  ────────▶   │  │BM25 │  (FTS5 only)   │
│  └──┬──┘ └────┬─────┘   │              │  └──┬──┘                 │
│     └──┬──────┘          │              │     │                    │
│     ┌──▼──┐              │              │     │                    │
│     │ RRF │              │              │     │                    │
│     └──┬──┘              │              │     │                    │
│  ┌─────▼───────┐         │              │     │                    │
│  │Intent+Rerank│         │              │     │                    │
│  └─────────────┘         │              │     │                    │
├──────────────────────────┤              ├──────▼───────────────────┤
│  Core                    │              │  Core                    │
│  memory, path, guard,    │              │  memory, path, guard     │
│  link, snapshot, export  │              │  export                  │
├──────────────────────────┤              ├──────────────────────────┤
│  Sleep                   │              │  Sleep                   │
│  decay, tidy, govern,    │              │  decay, tidy, govern,    │
│  boot, sync              │              │  boot, sync              │
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
| `boot` | 无变更 | 无变更 | — |
| `forget` | 无变更 | 无变更 | — |
| `link` | 知识图谱操作 | **删除** | 0 使用 |
| `snapshot` | 版本历史/回滚 | **删除** | 0 使用 |
| `reflect` | 无变更 | 无变更 | — |
| `status` | 含 links/snapshots 计数 | 删除 links/snapshots 计数 | 简化输出 |

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

---

## 5. Risks / 风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| recall 降级为 BM25-only，语义检索能力下降 | 与 embedding 相关的模糊查询可能命中率下降 | ① 31 条记忆 BM25 已足够；② 语义搜索应通过 memory-core 的 `memory_search` 完成 |
| 删除 link/snapshot 后无法恢复历史功能 | 如果未来需要知识图谱或版本控制 | ① 表结构保留，数据不丢；② 207 LOC 可在 1-2h 内重写 |
| 删除 snapshot 导致 update/merge 无备份 | 记忆内容被覆盖后无法回滚 | ① markdown 文件由 git 管理；② agent-memory 数据量小，手动修复成本低 |
| DD-0004（integration）和 DD-0005/0006 的设计前提被推翻 | 已实现的 embedding/reranker 集成代码被删除 | ① DD-0004 的 capture/surface 流程不依赖搜索栈；② DD-0005/0006 属于被取代的优化 |
| v3.0 breaking change 影响现有消费者 | mcporter 调用 link/snapshot 工具会 404 | ① 当前唯一消费者是 OpenClaw agent，可同步更新 AGENTS.md |

---

## 6. Test Plan / 测试方案

- [ ] **Unit: BM25 recall 验证**：recall 使用 BM25-only 搜索 + inline weighting，结果按 priority×vitality 排序
- [ ] **Unit: remember 不再调用 embedding**：remember 写入后无 embedding 表变更
- [ ] **Unit: tidy 不再操作 snapshots**：runTidy 返回 `{ archived, orphansCleaned }` 无 `snapshotsPruned`
- [ ] **Unit: govern 不再操作 links**：runGovern 返回 `{ orphanPaths, emptyMemories }` 无 `orphanLinks`
- [ ] **Integration: MCP server 只注册 7 个工具**：连接后 `tools/list` 不包含 link 和 snapshot
- [ ] **Integration: 旧 DB 兼容**：v2 创建的 DB（含 embeddings/links/snapshots 数据）在 v3 可正常打开
- [ ] **E2E: mcporter call agent-memory.recall**：搜索返回正确结果
- [ ] **E2E: mcporter call agent-memory.status**：输出不包含 links/snapshots 计数

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
│  │  • Temporal decay│  │  • Boot 身份加载          │ │
│  │                  │  │  • Sleep 生命周期         │ │
│  │  用途：          │  │  • BM25 简单检索          │ │
│  │  全文档语义搜索   │  │                          │ │
│  │  chunk 级检索     │  │  用途：                  │ │
│  │                  │  │  结构化记忆 CRUD          │ │
│  │                  │  │  身份/情感/知识/事件管理   │ │
│  │                  │  │  自动衰减 + 生命周期       │ │
│  └──────────────────┘  └────────────────────────┘ │
│                                                    │
│  memory_search → memory-core                       │
│  remember/recall → agent-memory                    │
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
