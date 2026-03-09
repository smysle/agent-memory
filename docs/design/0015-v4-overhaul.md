# DD-0015: AgentMemory v4 Overhaul —— 从 OpenClaw 补充层到通用 AI Agent 记忆层

**Status:** Draft
**Author:** Noah (GPT-5.4 sub-agent)
**Date:** 2026-03-09
**Repo:** agent-memory

---

## 1. Background / 背景

agent-memory 当前发布版本为 `@smyslenny/agent-memory@3.1.0`。它已经具备一套很有辨识度的记忆模型：

- 类型化记忆：`identity / emotion / knowledge / event`
- Ebbinghaus 衰减模型：`R = e^(-t/S)` + recall 续期
- URI 路径寻址
- Write Guard 四准则门控（specificity / novelty / relevance / coherence）
- `boot` 叙事格式
- 多 agent 隔离
- SQLite + MCP + CLI 的本地优先架构

这些能力让 agent-memory 在“结构化写入”和“生命周期管理”上已经有了可用基础，但它在日常高频使用中仍然没有成为 AI agent 的**主力记忆层**。核心原因不是“不会存”，而是“搜不准、去不掉、连不顺、接不广”。

### 1.1 真实使用中的核心痛点

| 优先级 | 痛点 | 当前症状 | 根因 |
|---|---|---|---|
| P0 | BM25 检索太弱，语义搜索缺失 | 搜“喜欢什么风格”找不到“禁止蓝紫渐变、玻璃拟态” | 仅靠 FTS5/BM25；ROADMAP 中 `search/semantic.ts` 只停留在占位 |
| P0 | Write Guard 去重粗糙 | 近义重复反复写入，浪费 200 条槽位 | 相似度只看 BM25 排名与 `token_count * 1.5` 阈值 |
| P1 | `reflect` 周期脆弱 | 外部 cron 调 `reflect` 时中途失败，恢复依赖重试 | 当前缺少 job log、phase checkpoint、端到端原子性 |
| P1 | `surface` 只会按 vitality 排序 | 不能根据当前对话/任务动态浮现相关记忆 | 只读浮现没有上下文建模 |
| P1 | 只有 stdio MCP + CLI，没有 HTTP API | mcporter 每次 spawn 进程，延迟高 | transport 只有 stdio，缺少常驻服务接口 |
| P2 | README / 文档不够 OSS 友好 | 看起来像 OpenClaw 专用配件，不像通用组件 | 文档定位、示例、benchmark 都过度依赖当前使用场景 |

### 1.2 次要但持续累积的问题

- 200 条硬上限的淘汰策略过于粗糙，主要靠最低 vitality 清理
- recall / surface 缺少“是否真的有用”的反馈信号
- ingest watcher 因重复过多而被关闭，说明自动摄取与去重策略不匹配
- 中文分词虽然接了 jieba，但与 FTS5 的协同仍偏浅层

### 1.3 为什么这是 v4 的转折点

v3 的定位更像“OpenClaw memory-core 的结构化补充层”。这在单一宿主内是成立的，但如果目标是把 agent-memory 做成**独立可用的通用 AI agent 记忆层**，那就必须满足下面三个条件：

1. **检索必须足够好用**：至少让 agent 愿意优先调用 `recall`
2. **写入必须足够节制**：不能让近义重复快速挤满配额
3. **接口必须足够通用**：不能只适配 stdio MCP + OpenClaw 工作流

因此，v4 不是一次“小修小补”，而是一次**产品定位回正**：

> 让 agent-memory 从“依赖宿主生态才好用的结构化索引层”，升级为“脱离 OpenClaw 也成立的通用 AI Agent Memory Layer”。

### 1.4 需要保留并增强的部分

以下能力已经是 agent-memory 的差异化资产，v4 不应推翻，而应作为新能力的稳定地基：

- Ebbinghaus 衰减模型与 recall 续期
- 类型化记忆与 priority 分层
- URI 路径系统
- Write Guard 的四准则门控框架
- `boot` 的叙事性输出
- 多 agent 隔离
- SQLite-first、本地优先的部署体验

---

## 2. Goals / 目标

1. **让 agent-memory 成为独立可用的通用 AI agent 记忆层**，不再依赖 OpenClaw 才能成立
2. **优先解决 recall 检索质量问题**，补齐 optional semantic retrieval，使 `recall` 再次成为主入口
3. **升级 Write Guard 为 semantic-aware 去重与合并系统**，减少近义重复与槽位浪费
4. **提升 lifecycle 可靠性**，让 `reflect` 具备 job 级可恢复性、明确的职责边界和可观测性
5. **新增 HTTP/SSE API**，降低进程桥接开销，支持更多 agent 框架直接集成
6. **把 `surface` 从静态排序升级为 context-aware surfacing**，让记忆能按当前任务浮现，而不是只按存量分数堆叠
7. **重写 README / 文档 / benchmark / examples**，把 OpenClaw 从“默认前提”降级为“一个集成示例”
8. **保持向后兼容的迁移路径**：未启用 semantic layer 的用户，仍能保留 BM25-only 运行方式

---

## 3. Non-Goals / 非目标

- **不做多模态记忆**：不在 v4 引入 image/audio/video embedding 或 multimodal recall
- **不做分布式存储**：不把 v4 设计成需要独立向量集群或远程数据库才能运行
- **不改核心衰减模型**：Ebbinghaus `R = e^(-t/S)`、priority 分层和 recall 续期保持不变
- **不把 agent-memory 重构成完整 workflow engine**：job/log 只服务于 memory lifecycle，不扩展为通用调度系统
- **不把 OpenClaw 集成彻底删除**：只是去耦并降级为 optional integration，而不是移除支持
- **不在 v4 恢复或扩展多跳知识图谱/多模态 graph reasoning**：优先级低于检索、去重、API 通用化

---

## 4. Proposal / 方案

### 4.1 方案概述

v4 采用**分阶段重构**，先修“检索”和“去重”这两个最影响日常体验的核心问题，再补 transport、surface 和文档生态。

整体原则：

1. **Optional semantics**：语义检索是可选增强，不是强制依赖
2. **SQLite-first**：默认仍然单机可运行，不要求外部向量服务
3. **One application core, many transports**：记忆逻辑与 MCP / CLI / HTTP 解耦
4. **Backward-compatible by default**：未配置 embedding 时自动退回 BM25-only
5. **Observability over magic**：每一步去重、合并、reflect 都要能解释、能追踪、能回退

### 4.2 方案对比

| 维度 | 方案 A：继续 BM25-only，微调 tokenizer | 方案 B：可选向量层 + 语义去重 + HTTP/SSE（本方案） | 方案 C：强制外部向量 DB + 全面服务化 |
|---|---|---|---|
| 检索提升 | 低 | **高** | 高 |
| 部署复杂度 | 低 | **中** | 高 |
| 对现有用户冲击 | 低 | **可控** | 高 |
| 通用性 | 中 | **高** | 高 |
| 本地优先 | 高 | **高** | 低 |
| 实施节奏 | 快，但收益有限 | **分阶段，收益最大** | 慢且风险高 |

选择**方案 B**。

理由：

- 仅靠 tokenizer 和 BM25 阈值微调，无法解决“近义表达搜不到 / 去不掉”的根问题
- 强制外部向量库会破坏 agent-memory 的 SQLite-first 特性，也会显著抬高接入门槛
- 可选向量层 + 默认本地运行，可以兼顾检索效果、部署体验与通用性

### 4.3 目标架构

```text
                    ┌───────────────────────────────┐
                    │           Clients             │
                    │ CLI | MCP stdio | HTTP | SSE  │
                    └──────────────┬────────────────┘
                                   │
                    ┌──────────────▼────────────────┐
                    │       Application Core         │
                    │ remember | recall | surface    │
                    │ guard | reflect | boot | stats │
                    └───────┬───────────┬───────────┘
                            │           │
            ┌───────────────▼───┐   ┌──▼────────────────────┐
            │   Retrieval Core   │   │   Lifecycle Core      │
            │ BM25 + Vector +    │   │ decay / tidy / govern │
            │ Hybrid Fusion      │   │ job log / checkpoint  │
            └───────────────┬───┘   └──┬────────────────────┘
                            │           │
              ┌─────────────▼───────────▼─────────────┐
              │               SQLite                  │
              │ memories / paths / embeddings / jobs  │
              │ feedback / schema_meta                │
              └─────────────┬───────────┬─────────────┘
                            │           │
             ┌──────────────▼───┐   ┌───▼─────────────────┐
             │ EmbeddingProvider │   │ VectorIndexAdapter  │
             │ OpenAI-compatible │   │ sqlite-blob default │
             │ local-http        │   │ optional ANN later  │
             └───────────────────┘   └─────────────────────┘
```

### 4.4 Phase 1：可选向量检索层（优先级最高）

#### 4.4.1 目标

在不破坏现有 BM25 路径的前提下，为 `recall` 增加 **optional semantic retrieval**，支持：

- OpenAI / OpenAI-compatible embedding provider
- local embedding provider（如 Ollama / 本地兼容 HTTP 服务）
- BM25 + vector hybrid ranking
- lazy backfill / reindex
- 未配置 provider 时自动退回 BM25-only

#### 4.4.2 设计要点

**(1) Provider 抽象**

```ts
interface EmbeddingProvider {
  id: string;
  model: string;
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
  healthcheck?(): Promise<void>;
}
```

首批支持两类 provider：

- `openai-compatible`：OpenAI、兼容 OpenAI 的 embedding endpoint
- `local-http`：本地 embedding 服务（例如 Ollama 或自建兼容接口）

这比硬编码具体厂商更通用，也更符合“独立 AI agent 记忆层”的目标。

**(2) VectorIndex 选型**

Phase 1 默认**不引入外部向量数据库**。

默认实现：

- 复用现有 `embeddings` 表存储向量（BLOB）
- 采用 in-process cosine similarity 扫描作为默认 vector search
- 仅在数据规模进一步放大后，预留 `sqlite-vec` / ANN adapter 接口

原因：

- agent-memory 的目标数据规模仍然偏“小而精”，默认场景没有必要为了向量搜索引入独立服务
- 这样可以把 semantic retrieval 做成真正的 optional capability，而不是新的运维负担

**(3) Hybrid Ranking**

`recall` 查询流程从：

```text
query -> BM25 -> priority/vitality weighting -> recordAccess
```

升级为：

```text
query
  ├─ lexical path  -> BM25 topK
  ├─ semantic path -> vector topK (if enabled)
  └─ fusion        -> Weighted RRF + business priors
                    -> final rerank
                    -> recordAccess
```

融合策略采用 **Weighted Reciprocal Rank Fusion (WRRF)**，避免直接混合 BM25 score 与 cosine score 的尺度问题。

建议公式：

```text
fusion_score = 0.45 / (60 + bm25_rank)
             + 0.45 / (60 + vector_rank)
             + 0.05 * priority_prior
             + 0.05 * vitality
```

其中：

- `bm25_rank` / `vector_rank` 缺失时视为 0 贡献
- `priority_prior` 归一化到 `[0,1]`
- `vitality` 直接作为轻量业务先验，不覆盖检索主排序

**(4) Embedding 生命周期**

- `remember` / `ingest` 成功写入后，仅标记“embedding dirty”
- 实际 embedding 生成可同步执行，也可 lazy/job 化
- `recall` 发现缺 embedding 时，不阻塞主查询；仅对已有向量做 semantic branch
- 提供 `reindex` CLI / HTTP API 做全量或增量重建

**(5) CJK 检索基线继续保留**

v4 不废弃当前 jieba + FTS5 方案，而是把它从“唯一召回路径”降为“lexical branch”。这意味着：

- 中文分词与 BM25 仍然重要
- 但 recall 的上限不再被 tokenizer 质量单点限制

#### 4.4.3 模块变更建议

| 模块 | 变更 |
|---|---|
| `src/search/semantic.ts` | 从占位文件升级为真实语义检索入口 |
| `src/search/hybrid.ts` | 新增 Hybrid recall / WRRF 融合逻辑 |
| `src/search/providers.ts` | 统一 openai-compatible / local-http provider |
| `src/core/memory.ts` | 增加 embedding dirty / content hash 对齐逻辑 |
| `src/mcp/server.ts` | `recall` 调用共享 retrieval service，不再内联 BM25-only 逻辑 |
| `src/bin/agent-memory.ts` | 新增 `reindex` / provider healthcheck 命令 |

#### 4.4.4 预期收益

- 解决“关键词不重合但语义相近”的 recall 失效问题
- 让 agent-memory 的 `recall` 再次具备主力价值
- 为后续 semantic dedup、context-aware surface 提供统一底座

### 4.5 Phase 2：Write Guard 升级（语义去重 + 更智能合并）

#### 4.5.1 目标

把当前“BM25 排名 + 动态阈值”的粗粒度去重，升级为 **semantic-aware dedup & merge pipeline**。

要解决的问题不是“纯重复”，而是：

- 同义改写
- 轻微扩写
- 同一知识点的不同表达
- 同一事件的重复记录
- 同一偏好的不同措辞

#### 4.5.2 新的 Guard Pipeline

```text
1. exact hash dedup
2. URI conflict check
3. hybrid candidate recall (topN)
4. semantic dedup scoring
5. merge policy selection
6. four-criterion gate
7. add / skip / update / merge
```

其中第 3~5 步是 v4 核心升级。

**候选召回**：

- 优先在同 `agent_id`、同 `type`、同 URI domain 内召回候选
- 使用 Phase 1 的 hybrid retrieval 作为 Guard 的候选集入口
- 对 `event` 类型额外参考时间窗口（例如 24h / 7d）

**去重得分建议公式**：

```text
dedup_score = 0.50 * semantic_similarity
            + 0.20 * lexical_overlap
            + 0.15 * uri_scope_match
            + 0.10 * entity_overlap
            + 0.05 * time_proximity
```

建议阈值：

- `>= 0.93`：视为 near-exact duplicate，`skip` 或 `update metadata`
- `0.82 ~ 0.93`：进入 `merge` 分支
- `< 0.82`：默认 `add`

#### 4.5.3 Merge 策略不能再是简单字符串拼接

当前 merge 近似：

```text
旧内容 + "\n\n[Updated] " + 新内容
```

这对 `knowledge` 和 `identity` 基本不可读，也会不断恶化检索质量。v4 需要按类型做 merge policy：

| 类型 | 默认策略 | 说明 |
|---|---|---|
| `identity` | canonical replace / patch | 保持单一权威表述，旧措辞作为 alias/source 留痕 |
| `emotion` | append evidence | 保留情绪时间线，但避免同义重复刷屏 |
| `knowledge` | synthesize canonical statement | 合并同义表达、保留关键约束词与 alias |
| `event` | time-window compact | 同一事件窗口内合并；不同时间的相似事件应分开保存 |

建议引入 `merge.ts` 或 `guard/merge-policy.ts`，输出结构化 `MergePlan`：

```ts
interface MergePlan {
  strategy: "replace" | "append_evidence" | "synthesize" | "compact_timeline";
  content: string;
  aliases?: string[];
  notes?: string[];
}
```

#### 4.5.4 reflect 可靠性一起修，不再让维护链条继续脆弱

虽然本 Phase 的主题是 Write Guard，但去重、合并、归档本质上都属于“写入质量与生命周期可靠性”的同一问题，因此 v4 应该在这里同步补上 reflect 的 job 化能力。

新增：

- `maintenance_jobs` 表：记录 `job_id / phase / status / checkpoint / error / started_at / finished_at`
- `reflect.ts` 编排器：统一驱动 `decay / tidy / govern`
- phase checkpoint：`all` 模式下支持从失败点恢复
- 职责边界明确化：
  - `tidy`：压缩、合并、归档
  - `govern`：配额治理、孤儿清理、策略淘汰

这可以直接解决：

- `reflect` 中途失败只能靠外部盲重试的问题
- `tidy` / `govern` 角色重叠的问题
- 200 条上限下只按最低 vitality 粗暴清理的问题

#### 4.5.5 配额淘汰策略升级

当容量接近上限时，治理不应只看 vitality，而应看“保留价值”。

建议引入 eviction score：

```text
eviction_score = 0.40 * (1 - vitality)
               + 0.20 * redundancy_score
               + 0.20 * age_score
               + 0.10 * low_feedback_penalty
               + 0.10 * low_priority_penalty
```

高 `eviction_score` 的候选优先被 compact / archive / drop。

这样可以把“重复但活得还行”的垃圾记忆排到更靠前的位置，而不是只砍最老最弱的 event。

### 4.6 Phase 3：HTTP/SSE API + 更好的 surface（上下文感知浮现）

#### 4.6.1 目标

让 agent-memory 从“只能通过 stdio MCP 桥接调用的本地工具”，升级为“可被任意 agent runtime 直接接入的通用服务”。

同时，把 `surface` 从静态 top-N 排序升级为 **context-aware surfacing**。

#### 4.6.2 Transport 重构

v4 应拆出共享 application service，避免 `mcp/server.ts` 继续承担全部业务逻辑。

建议结构：

```text
src/app/
  remember.ts
  recall.ts
  surface.ts
  reflect.ts
  status.ts

src/transports/
  mcp.ts
  http.ts
  sse.ts
```

MCP、CLI、HTTP 三个入口只做：

- 参数校验
- 调用 app service
- 格式化返回

而不是各自实现一套业务。

#### 4.6.3 HTTP API 设计

建议新增：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `GET` | `/v1/status` | 统计信息 |
| `POST` | `/v1/memories` | `remember` |
| `POST` | `/v1/recall` | 语义/混合检索 |
| `POST` | `/v1/surface` | 上下文浮现 |
| `POST` | `/v1/reflect` | 触发 lifecycle job |
| `POST` | `/v1/reindex` | 触发 embedding backfill |
| `POST` | `/v1/feedback` | 记录 recall/surface 是否有用 |
| `GET` | `/v1/jobs/:id` | 查看 job 状态 |

SSE 主要用于：

- `reflect` 长任务进度
- `reindex` 进度
- watcher / ingest / maintenance 事件流（可选）

#### 4.6.4 surface 升级为 context-aware

当前 `surface` 主要依赖关键词 OR 命中和 `priority × vitality` 排序。v4 需要让它理解“当前正在做什么”。

建议新输入：

```ts
interface SurfaceInput {
  query?: string;
  task?: string;
  recent_turns?: string[];
  intent?: "factual" | "preference" | "temporal" | "planning" | "design";
  types?: Array<"identity" | "emotion" | "knowledge" | "event">;
  limit?: number;
  record_feedback?: boolean;
}
```

新排序建议：

```text
surface_score = 0.35 * semantic_score
              + 0.20 * lexical_score
              + 0.15 * task_match
              + 0.10 * vitality
              + 0.10 * priority_prior
              + 0.10 * feedback_score
```

关键差异：

- `surface` 默认仍然**不记录 access**，避免污染衰减模型
- 但可以单独记录 `feedback`，区分“被展示过”和“真的有用过”
- 返回结果需要附带 `reason codes`，例如：
  - `semantic:ui-style`
  - `type:knowledge`
  - `task:design`
  - `feedback:reinforced`

这样 `surface` 才能真正服务于：

- 对话上下文注入
- 任务导向提示
- 设计偏好浮现
- 长期偏好/身份记忆的动态补全

### 4.7 Phase 4：文档/README 大修 + 通用化

#### 4.7.1 目标

把 agent-memory 从“作者自己会用”的项目，升级为“别人看一眼就知道怎么接、值不值得接”的 OSS 项目。

#### 4.7.2 文档重构方向

**README 首页应该回答 5 个问题：**

1. 这个项目是什么？
2. 它和向量数据库/普通 RAG/记忆摘要有什么不同？
3. 什么时候应该用它？
4. 最短 5 分钟如何跑起来？
5. 怎么接入我的 agent runtime？

**文档结构建议：**

```text
docs/
  architecture/
    overview.md
    retrieval.md
    lifecycle.md
  integrations/
    openclaw.md
    langchain.md
    autogen.md
    crewai.md
  benchmarks/
    retrieval.md
    dedup.md
    lifecycle.md
  examples/
    node-http/
    python-http/
    mcp-stdio/
```

#### 4.7.3 必须补齐的内容

- 架构图（写路径、读路径、生命周期路径）
- benchmark：
  - 中文/英文 recall benchmark
  - paraphrase dedup benchmark
  - reflect/reindex reliability benchmark
- examples：
  - 纯 HTTP 接入
  - MCP stdio 接入
  - LangChain / AutoGen / CrewAI 最小示例
- migration guide：`v3 -> v4`
- OpenClaw 集成文档单独下沉，不再挤占首页叙事

#### 4.7.4 通用化原则

- README 默认不再假设用户使用 OpenClaw
- “memory/*.md + MEMORY.md” 模式从产品定义改为一个 optional workflow
- 所有环境变量、命令示例优先使用通用 naming 与 generic runtime 场景
- OpenClaw 只作为一个“实践良好的宿主示例”保留

### 4.8 Schema / 兼容性建议

为降低 v4 风险，数据库变更应尽量采取**增量迁移**：

| 表 / 字段 | 变更 |
|---|---|
| `embeddings` | 增加 `content_hash` / `provider_id` / `status`（或等价元数据） |
| `maintenance_jobs` | 新增，记录 `reflect/reindex` 等后台任务 |
| `feedback_events` | 新增，记录 recall/surface 的 usefulness 信号 |
| `memories` | 如需保留 canonical/alias 信息，可优先走附表而不是直接改 content 主结构 |

兼容策略：

- 原有 MCP tool 名保持可用
- 原有 CLI 基础命令保持可用
- 若无 embedding provider，语义检索路径自动禁用
- 新 HTTP/SSE API 为 additive，不替代现有 MCP
- 旧库升级后不强制全量 reindex，可 lazy backfill

---

## 5. Risks / 风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Embedding 依赖增加复杂度 | 增加配置、网络、成本与故障面 | 语义层保持 optional；默认仍可 BM25-only 运行；提供 provider healthcheck 与 clear fallback |
| 向量存储选型失误 | 过早引入重型基础设施，破坏 SQLite-first 体验 | Phase 1 默认采用 SQLite BLOB + in-process cosine；ANN/外部向量库延后为可选 adapter |
| Backward compatibility 破坏现有 MCP/CLI 调用 | 现有用户升级困难 | 保持现有工具名与基础参数；新增能力尽量 additive；提供 `v3 -> v4` migration guide |
| 语义去重误判导致“该保留的被合并/覆盖” | 数据质量受损，用户失去信任 | merge 采用 explainable score + typed policy；高风险 merge 提供 conservative fallback；保留 audit log |
| Hybrid retrieval 提高延迟 | recall 变慢，影响在线 agent 交互 | provider timeout、query cache、topK 限制、lazy semantic branch；provider 不可用时即时降级 |
| reflect job 化后实现复杂度上升 | 生命周期逻辑更难维护 | 引入单独 `reflect.ts` 编排层和 job state machine，避免把恢复逻辑塞进 transport 层 |
| feedback 信号被滥用或稀疏 | 排序被噪声污染 | feedback 只作为轻量辅助特征，不覆盖 semantic/lexical 主分数；支持过期衰减 |
| 文档大修投入大但短期不显眼 | 影响开发节奏 | 文档 Phase 4 独立推进，不阻塞 Phase 1/2 的核心价值修复 |

---

## 6. Test Plan / 测试方案

- [ ] **Unit:** `EmbeddingProvider` 抽象支持 openai-compatible / local-http，两者在 provider 不可用时能正确 fallback
- [ ] **Unit:** Hybrid retrieval 的 WRRF 融合逻辑在 BM25-only / vector-only / dual-path 三种模式下结果稳定
- [ ] **Unit:** `recall` 对中文近义查询能命中语义相关 memory（包含“风格”→“蓝紫渐变/玻璃拟态”类用例）
- [ ] **Unit:** `Write Guard` 对 near-duplicate paraphrase 正确判定 `skip` / `merge` / `add`
- [ ] **Unit:** typed merge policy 对 `identity` / `knowledge` / `event` 输出不同 merge 行为
- [ ] **Unit:** eviction score 能优先清理“高冗余低价值”记忆，而不是只看最低 vitality
- [ ] **Integration:** `remember -> embedding dirty -> reindex -> recall` 全链路可用
- [ ] **Integration:** `reflect phase=all` 在中途故障后可通过 job checkpoint 恢复
- [ ] **Integration:** MCP 与 HTTP API 使用同一 app service，返回语义保持一致
- [ ] **Integration:** SSE 能持续输出 `reflect` / `reindex` 进度与最终状态
- [ ] **Benchmark:** 中文/英文 recall benchmark（关键词不重合、语义相近场景）
- [ ] **Benchmark:** paraphrase dedup benchmark（偏好、风格、约束、事件四类）
- [ ] **Benchmark:** `reflect` reliability benchmark（注入失败、重复执行、恢复执行）
- [ ] **Manual:** LangChain / AutoGen / CrewAI / OpenClaw 四类示例均可跑通最小集成
- [ ] **Manual:** 无 embedding provider 环境下，v4 仍可作为 BM25-only + MCP/CLI 运行

---

## 7. Rollback Plan / 回滚方案

1. **语义层可一键关闭**：若 embedding provider 不稳定或效果不佳，关闭 semantic feature flag 后自动退回 BM25-only
2. **HTTP/SSE 可独立关闭**：保留现有 MCP stdio 作为稳定回退路径
3. **Schema 采用增量迁移**：新增表/字段不破坏旧数据；必要时可忽略新表继续运行核心功能
4. **Guard 策略可降级**：若 semantic dedup 误判，回退到 conservative 模式（仅 exact hash + URI conflict + 四准则）
5. **Lifecycle 编排可回退**：保留单 phase 手动执行能力，在 job 编排出问题时仍能单独跑 `decay/tidy/govern`
6. **Git 回滚清晰**：v4 各 Phase 尽量拆分提交，便于按阶段 `git revert`

---

## 8. Decision Log / 决策变更记录

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-03-09 | 语义检索采用 optional layer，而不是强制外部向量服务 | 保持 SQLite-first、本地优先与低接入门槛 |
| 2026-03-09 | Hybrid retrieval 融合默认选 Weighted RRF，而非直接混合 BM25/cosine 原始分数 | 避免不同打分尺度难以校准，提升实现稳定性 |
| 2026-03-09 | Write Guard 升级与 reflect job 化放在同一阶段统筹设计 | 去重、合并、归档、治理本质上属于同一条“写入质量/生命周期可靠性”链路 |
| 2026-03-09 | HTTP/SSE 与 MCP 共享 application core，不在 transport 层复制业务逻辑 | 避免多接口并存后逻辑漂移 |
| 2026-03-09 | 文档 Phase 明确把 OpenClaw 从“默认前提”降级为“集成示例” | 目标是让 agent-memory 成为独立可用的通用 AI agent 记忆层 |

---

_Generated by DD workflow · GPT-5.4 sub-agent_
