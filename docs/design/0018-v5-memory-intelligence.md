# DD-0018: v5 Memory Intelligence — 关联 · 冲突 · 时间 · 反馈 · 语义衰减 · 溯源

- **Status:** Draft → Reviewed (pending approval)
- **Reviewer:** Gemini 3.1 Pro (2026-03-20)
- **Created:** 2026-03-20
- **Author:** Noah (orchestrator)

---

## 1. Background 背景

agent-memory v4.x 建立了可靠的记忆基础设施（Write Guard、Ebbinghaus 衰减、双路召回、feedback 框架），但实际使用中暴露了六个核心缺陷：

1. **记忆孤岛** — 每条记忆独立存储，语义相关的记忆之间没有关联，搜到一条无法带出相关条目
2. **冲突盲区** — 写入矛盾内容时系统不检测不提醒，新旧信息悄悄共存
3. **时间维度缺失** — 召回只看语义相关性，无法按时间加权或过滤，"最近发生了什么"类查询效果差
4. **反馈冷启动** — feedback 完全依赖主动调用，无被动信号收集，导致无人使用
5. **衰减无语义** — reflect 只按 Ebbinghaus 曲线（时间+访问频率）衰减，不判断内容是否已过时
6. **记忆无溯源** — 不知道每条记忆在什么时候、什么对话上下文中产生

## 2. Goals 目标

### Must Have (P0)

- **F1 记忆关联（Memory Links）**：写入时自动检测语义相关记忆并建立轻量关联，召回时支持 `related` 展开
- **F2 冲突检测（Conflict Detection）**：写入时检测与已有记忆的语义冲突，返回冲突警告让调用者决策
- **F3 时间维度召回（Temporal Recall）**：recall/surface 支持时间范围过滤和 recency boost
- **F4 被动反馈（Passive Feedback）**：记忆被引用进回复时自动记录正面反馈，无需主动调用
- **F5 语义衰减（Semantic Decay）**：reflect 阶段增加"过时检测"，基于关键词模式识别已完成/已取消的记忆
- **F6 记忆溯源（Memory Provenance）**：记忆携带来源元数据（session_id、timestamp、trigger_context）

### Non-Goals

- 完整的知识图谱（不做推理、不做多跳遍历）
- LLM 驱动的冲突解决（只检测，不自动解决）
- 跨 agent 记忆共享（v6 规划）
- 向量模型热迁移（v6 规划）

## 3. Proposal 方案

### 3.1 F1: Memory Links（记忆关联）

**核心思路：** 利用已有的 `links` 表，在 `syncOne()` 写入成功后自动建立关联。

#### Schema

已有 `links` 表满足需求：
```sql
-- 已有，无需修改
CREATE TABLE links (
  agent_id    TEXT NOT NULL DEFAULT 'default',
  source_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL,       -- 'related' | 'supersedes' | 'contradicts'
  weight      REAL NOT NULL DEFAULT 1.0,  -- 关联强度 (0-1)
  created_at  TEXT NOT NULL,
  PRIMARY KEY (agent_id, source_id, target_id)
);
```

#### 写入时自动关联

在 `syncOne()` 完成 `add` 或 `merge` 后：
1. 用 guard 阶段已有的候选记忆（`recallCandidates` 结果），筛选 `dedup_score ∈ [0.45, 0.82)` 的候选
2. 对每个候选，创建 `links` 记录：`relation='related'`, `weight=dedup_score`
3. 上限：每条记忆最多 5 条自动关联（取 score 最高的）

> **实现注意：** 当前 `guard.ts` 在第 185 行 `const best = candidates[0]` 只取 top-1 候选。
> F1 需要遍历多个候选（最多 5 个），F2 也需要对比多个候选检测冲突。
> Phase 2 实施时必须重构 `guard()` 的候选处理逻辑，将完整候选列表透传给
> 关联和冲突检测模块，而不是只截取 top-1。

#### Guard 结果扩展（透传候选列表）

`GuardResult` 新增字段供 `syncOne` 消费：
```ts
export interface GuardResult {
  // ... existing fields
  candidates?: Array<{           // 新增：完整候选列表（用于自动关联）
    memoryId: string;
    dedup_score: number;
  }>;
  conflicts?: ConflictInfo[];    // 新增：冲突信息（F2）
}
```

#### 召回时展开

`recall` 和 `surface` 新增可选参数 `related: boolean`（默认 false）：
- 为 true 时，对 top-K 结果查询 `links` 表，追加关联记忆（去重、不超过 `limit * 1.5`）
- 关联记忆的 score 按 `original_score * link_weight * 0.6` 计算
- MCP tool `recall` 增加 `related` 参数

#### 关联记忆标识

关联展开带入的记忆必须在结果中标识来源，避免 agent 困惑"为什么搜 A 出来了 B"：
```ts
export interface HybridRecallResult {
  // ... existing fields
  related_source_id?: string;   // 新增：如果此结果是关联展开带入的，指向源记忆 ID
  match_type?: 'direct' | 'related';  // 新增：直接命中 or 关联展开
}
```

#### 新增 MCP Tool

`link` — 手动创建/删除关联：
```
link(source_id, target_id, relation, weight?, remove?)
```

### 3.2 F2: Conflict Detection（冲突检测）

**核心思路：** 在 Write Guard 的 `guard()` 函数中增加冲突检测阶段。

#### 检测逻辑

在 `guard()` 的候选召回之后、action 决策之前：

1. 对 `dedup_score ∈ [0.60, 0.93)` 的候选，进行冲突特征检测：
   - **否定词检测**：一方包含否定词（不、没、禁止、no、not、never、don't、isn't）而另一方不包含
   - **数值冲突**：相同实体的数值不同（如 IP 地址、端口号、版本号）
   - **状态冲突**：一方标记为完成/取消/放弃，另一方仍为进行中

2. 冲突信号打分（0-1），三个维度加权：
   - 语义相似度高但否定词不一致：0.4
   - 数值差异：0.3
   - 状态矛盾：0.3

3. 冲突分 > 0.5 时，`GuardResult` 增加 `conflicts` 字段：
   ```ts
   conflicts?: Array<{
     memoryId: string;
     content: string;
     conflict_score: number;
     conflict_type: 'negation' | 'value' | 'status';
     detail: string;
   }>;
   ```

4. **不阻止写入**，只报告。调用者（agent）决定是否更新旧记忆或忽略。

#### ⚠️ 冲突否决规则（Conflict Override）

**当冲突检测发现状态冲突或数值冲突时，必须打破去重拦截。**

场景：旧记忆 = "TODO: 修复侧边栏 bug"，新写入 = "DONE: 修复侧边栏 bug"。
二者仅状态词不同，dedup_score 极可能 > 0.93，按原有逻辑 guard 会返回 `skip`。
但这明显是状态更新，不是重复。

规则：
- 冲突检测的范围扩展到 `dedup_score ∈ [0.60, +∞)`（不设上限）
- 如果 `dedup_score >= 0.93` **且** 检测到 `status` 或 `value` 类型冲突：
  - 将 action 从 `skip` 强制降级为 `update`
  - `updatedContent` 设为新内容
  - 同时在 `conflicts` 中报告冲突详情
- 如果 `dedup_score ∈ [0.82, 0.93)` 且检测到冲突：
  - 保持原有 `merge` 行为，但在 `conflicts` 中报告
- `negation` 类型冲突不触发否决（误报率高），仅报告

#### SyncResult 扩展

```ts
export interface SyncResult {
  action: "added" | "updated" | "merged" | "skipped";
  memoryId?: string;
  reason: string;
  conflicts?: ConflictInfo[];  // 新增
}
```

### 3.3 F3: Temporal Recall（时间维度召回）

#### recall / surface 参数扩展

```ts
// RecallInput / SurfaceInput 新增
after?: string;    // ISO 8601，只返回此时间之后创建/更新的记忆
before?: string;   // ISO 8601，只返回此时间之前创建/更新的记忆
recency_boost?: number;  // 0-1，默认 0。越高越偏向最近的记忆
```

#### 实现

1. **时间过滤**：在 BM25 和 vector 搜索的 SQL 查询中增加 `WHERE updated_at >= ? AND updated_at <= ?` 条件
2. **Recency Boost**：在 fusion score 计算中增加时间衰减项：
   ```
   recency_score = e^(-days_since_update / 30)
   final_score = (1 - recency_boost) * base_score + recency_boost * recency_score
   ```
3. MCP tools `recall` 和 `surface` 增加 `after`, `before`, `recency_boost` 参数

#### BM25 查询扩展

`searchBM25()` 增加 `after` / `before` 可选参数，在 SQL 层面过滤。

#### Vector 查询扩展

`searchByVector()` 增加 `after` / `before` 可选参数，在 SQL 层面过滤。

### 3.4 F4: Passive Feedback（被动反馈）

**核心思路：** recall/surface 返回结果时，标记被"使用"的记忆为正面反馈。

#### 机制

1. `recall` 已有 `recordAccess` 行为 — 这可以作为被动反馈的信号
2. 新增 `recordPassiveFeedback()` 函数：在 `recordAccess` 的同时，自动写入 `feedback_events`，source 为 `'passive'`
3. `FeedbackSource` 扩展为 `"recall" | "surface" | "passive"`

#### 触发条件

- `recall` 调用且 `recordAccess !== false` → 对返回的 top-3 结果记录 passive 正面反馈
- `surface` 默认不记录（它是 readonly 的设计），但增加可选 `recordFeedback: boolean`

#### 防滥用

- 同一条记忆在 24 小时内最多记录 3 次 passive 反馈（防 agent 反复搜索同一查询）
- passive 反馈的 value 为 0.7（低于主动 recall 的 1.0）
- 防重复检查使用批量查询 `WHERE memory_id IN (...) AND created_at > ? GROUP BY memory_id`，
  避免逐条 `SELECT COUNT(*)` 的 N+1 查询问题

### 3.5 F5: Semantic Decay（语义衰减）

**核心思路：** 在 reflect 的 `tidy` 阶段增加"过时检测"，不依赖 LLM。

#### 过时模式匹配

新增 `isStaleContent(content: string, type: MemoryType): { stale: boolean; reason: string; decay_factor: number }` 函数：

**作用域限定：** 语义衰减模式匹配仅对 `event` 类型记忆完整生效。对 `knowledge` 类型，
仅匹配句首锚定的明确临时性标记（如 `^TODO:` `^WIP:` `^待办：`），避免误伤包含这些词的
知识性描述（如"处理 TODO 的标准流程是..."）。`identity` 和 `emotion` 类型不参与语义衰减。

```ts
// event 类型：宽松匹配
const EVENT_STALE_PATTERNS = [
  { pattern: /正在|进行中|部署中|处理中|in progress|deploying|working on/i, type: 'in_progress', decay: 0.3 },
  { pattern: /待办|TODO|等.*回复|等.*确认|需要.*确认/i, type: 'pending', decay: 0.5 },
  { pattern: /刚才|刚刚|just now|a moment ago/i, type: 'ephemeral', decay: 0.2 },
];

// knowledge 类型：仅句首锚定
const KNOWLEDGE_STALE_PATTERNS = [
  { pattern: /^(TODO|WIP|FIXME|待办|进行中)[：:]/im, type: 'pending', decay: 0.5 },
  { pattern: /^(刚才|刚刚)/m, type: 'ephemeral', decay: 0.2 },
];
```

#### Tidy 阶段集成

在 `runTidy()` 中：
1. 对所有 P2 (`knowledge`) / P3 (`event`) 记忆运行 `isStaleContent(content, type)`
2. 函数内部根据 type 选择对应的 pattern 集合
3. 匹配到模式且 age 超过阈值 → `vitality *= decay_factor`

年龄阈值：
- `in_progress` → age > 7 天
- `pending` → age > 14 天
- `ephemeral` → age > 3 天

#### TidyResult 扩展

```ts
export interface TidyResult {
  archived: number;
  orphansCleaned: number;
  staleDecayed: number;  // 新增：语义衰减的记忆数
}
```

### 3.6 F6: Memory Provenance（记忆溯源）

#### Schema 变更

memories 表增加列：

```sql
ALTER TABLE memories ADD COLUMN source_session TEXT;     -- session ID
ALTER TABLE memories ADD COLUMN source_context TEXT;     -- 触发记忆的简短上下文 (≤200 chars)
ALTER TABLE memories ADD COLUMN observed_at TEXT;        -- 事件实际发生时间（区别于 created_at 写入时间）
```

#### CreateMemoryInput 扩展

```ts
export interface CreateMemoryInput {
  // ... existing fields
  source_session?: string;
  source_context?: string;
  observed_at?: string;
}
```

#### MCP Tool 扩展

`remember` 增加参数：
- `session_id?: string` — 来源 session
- `context?: string` — 触发上下文（≤200 chars，自动截断）
- `observed_at?: string` — 事件实际发生时间

`recall` / `surface` 返回结果增加溯源字段。

#### Migration

Schema version 6 → 7：
- 三个新列都是 nullable，纯增量迁移
- 旧记忆的 `source_session` / `source_context` 为 null

#### Guard timeProximity 重构

当前 `guard.ts` 中的 `timeProximity()` 函数通过正则从 `content`/`uri`/`source` 中猜测时间。
F6 引入了显式的 `observed_at` 字段后，`timeProximity()` 应优先使用 `observed_at`：

```ts
// 优先级：observed_at > source > uri > content > created_at
function extractObservedAt(parts, fallback): Date | null {
  // 新增：如果 input 或 memory 有 observed_at，直接使用
  // 回退到原有的正则猜测逻辑
}
```

`GuardInput` 新增可选字段 `observed_at?: string`，传递给 `timeProximity()`。

## 4. Risks 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 自动关联噪音过多 | 关联图变成全连接 | dedup_score 下限 0.45 + 每条记忆上限 5 关联 |
| 冲突检测误报 | agent 被错误警报干扰 | 冲突分阈值 0.5 较保守 + 不阻止写入 + negation 类型不触发否决 |
| 冲突否决误触发 | 非冲突的相似记忆被强制 update | 仅 status/value 冲突触发否决，negation 不触发；阈值保守 |
| 时间过滤性能 | 大量记忆时 SQL 变慢 | updated_at 已有索引，增加 created_at 索引 |
| Passive feedback 滥用 | 同一记忆被反复搜索导致分数虚高 | 24h 内同记忆上限 3 次，批量查询防 N+1 |
| 语义衰减误判 | knowledge 中含 TODO 等关键词被误衰减 | knowledge 仅匹配句首锚定模式，event 宽松匹配 |
| Schema migration | 现有数据库升级失败 | 纯 additive columns，nullable，有回滚路径 |

## 5. Test Plan 测试计划

### 5.1 单元测试

- **F1 Links:** 自动关联创建、上限约束、召回展开、手动 link/unlink
- **F2 Conflict:** 否定词检测、数值冲突、状态冲突、冲突分计算、边界情况
- **F3 Temporal:** after/before 过滤、recency_boost 排序、空范围处理
- **F4 Passive Feedback:** 自动记录、24h 防重复、value 系数
- **F5 Semantic Decay:** 各模式匹配、年龄阈值、vitality 更新
- **F6 Provenance:** 创建时写入、召回时返回、migration 兼容

### 5.2 集成测试

- 完整流程：remember → recall with related → feedback → reflect → verify decay
- Migration v6 → v7 正向/回滚
- MCP tool 端到端

### 5.3 回归

- 现有 66 个测试全部通过
- 性能：200 条记忆下 recall 延迟 < 100ms

## 6. Rollback Plan 回滚

- Schema v7 的三个新列都是 nullable，回滚到 v6 只需忽略新列
- links 表已存在，新数据可 `DELETE FROM links WHERE relation IN ('related', 'contradicts', 'supersedes')`
- feedback_events 新增的 passive 类型可按 source='passive' 清除
- 所有新参数都有默认值，不传则行为与 v4 一致

## 7. Implementation Plan 实施计划

### Phase 1: Schema + Migration (F6)
1. 增加 provenance 列（source_session, source_context, observed_at）
2. Schema v6 → v7 迁移
3. 更新 CreateMemoryInput 和 MCP tools

### Phase 2: Core Intelligence (F1, F2)
4. **重构 `guard.ts` 候选处理循环** — 支持多候选遍历（当前只取 top-1），将完整候选列表透传给 GuardResult
5. 实现自动关联（links 写入 + 关联展开 + `related_source_id` 标识）
6. 实现冲突检测（冲突信号检测 + 冲突否决规则 + conflict 信息透传）
7. 新增 `link` MCP tool

### Phase 3: Recall Enhancement (F3, F4)
8. 时间过滤（BM25/vector SQL 扩展 + created_at 索引）
9. Recency boost（fusion score 扩展）
10. Passive feedback（recordAccess 联动 + 批量防重复查询）
11. MCP tool 参数扩展

### Phase 4: Smart Decay (F5)
12. 过时模式匹配器（按 MemoryType 分集 + 句首锚定）
13. Tidy 阶段集成
14. TidyResult 扩展

### Phase 5: 集成验证
15. 全量测试通过
16. npm publish v5.0.0
17. 更新 README

## 8. Decision Log 决策日志

| 日期 | 决策 | 原因 |
|------|------|------|
| 2026-03-20 | 冲突检测不阻止写入 | 误报风险高，让调用者（agent）决策更安全 |
| 2026-03-20 | 关联用已有 links 表 | 避免新增表，schema 已经够用 |
| 2026-03-20 | passive feedback 走 feedback_events 表 | 复用已有基础设施，不额外建表 |
| 2026-03-20 | 语义衰减不用 LLM | 保持零外部依赖原则，模式匹配够用 |
| 2026-03-20 | 六个特性一个 DD | 特性间有交叉依赖（F1/F2 共用候选、F4 依赖 F3 的 recall 改造） |
| 2026-03-20 | [评审修订] 冲突否决规则 | Gemini 评审发现 dedup skip 会吞掉状态更新，增加 status/value 冲突强制降级为 update |
| 2026-03-20 | [评审修订] 关联记忆标识 | Gemini 评审指出关联展开结果混入 top-K 会让 agent 困惑，增加 related_source_id + match_type |
| 2026-03-20 | [评审修订] 语义衰减作用域 | Gemini 评审发现宽泛正则会误伤 knowledge 类记忆，改为按 type 分集 + 句首锚定 |
| 2026-03-20 | [评审修订] timeProximity 重构 | Gemini 评审指出 F6 的 observed_at 应回馈到 guard 的时间差计算 |
| 2026-03-20 | [评审修订] passive feedback 批量查询 | Gemini 评审指出防重复检查应避免 N+1 查询 |
