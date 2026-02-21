# DD-0004: Markdown × agent-memory 生命周期融合

**Status:** Draft
**Author:** Noah (Claude Opus sub-agent)
**Date:** 2026-02-21
**Repo:** agent-memory

---

## 1. Background / 背景

OpenClaw 当前有两套记忆系统并行运行：

- **Markdown 记忆**：`memory/YYYY-MM-DD.md` 日记 + `MEMORY.md` 长期记忆 + `RECENT.md` 短期摘要。由 `memory-sync`（14:00 & 22:00）和 `memory-tidy`（03:00）两个 cron 维护。自动注入 session 上下文，人类可读可编辑。
- **agent-memory**（v2.1.0）：SQLite-backed 结构化记忆，提供 Ebbinghaus 衰减、BM25+向量混合搜索、URI 路径树、知识图谱链接。通过 mcporter MCP bridge 暴露 9 个工具。

**两处集成 Gap（来自 `integration-plan-v1.md`）：**

1. **Decay 引擎不会自动触发**：agent-memory 的衰减是被动的，只在显式调用 `reflect` 时执行。当前虽已有独立 cron 每天凌晨 4 点触发，但与 memory-tidy 的"深度睡眠"周期脱节，且无法利用 tidy 阶段的上下文信息。
2. **双存储状态分裂**：memory-sync 只写 Markdown，agent-memory 只在主 session 手动 `remember` 时写入。两边数据源独立增长，日渐分裂。`RECENT.md` 虽已由独立 `memory-surface` cron 生成，但其生成逻辑尚未标准化到 integration-plan 的设计规范。

**PR #2（`memory-janitor-phase5.md`）** 已提出"Phase 5"概念——在 janitor 收尾时触发 decay + consistency check，但只是示例 prompt 片段，尚未落地到 OpenClaw cron 中。

---

## 2. Goals / 目标

1. **Capture 同步**：`memory-sync` 写日记时，同步通过 `mcporter call agent-memory.remember` 将每条新增 bullet 写入 agent-memory，实现 1:1 增量同步。
2. **Consolidate 联动**：`memory-tidy` 收尾时触发 `mcporter call agent-memory.reflect phase=all`（含 decay + tidy + govern），替代独立的凌晨 4 点 cron。
3. **Surface 标准化**：`memory-surface` cron 从 agent-memory 提取高 vitality / 近期记忆，按标准模板生成 `RECENT.md`，供主 session 上下文自动加载。
4. **Best-effort 容错**：所有 mcporter 调用失败时仅 warn，不影响 Markdown 写入主流程。

---

## 3. Non-Goals / 非目标

- **不改 agent-memory 代码**：v1 纯 prompt 改造 + cron 配置，零代码变更。
- **不引入新依赖/新模型**：分类用关键词规则，surface 用模板拼接。
- **不做双向合并**：Markdown 为 source of truth，agent-memory 为派生索引层，不反向回写日记。
- **不做统一检索入口**：memory_search + agent-memory recall 的 RRF 合并留给 v2。
- **不扩大上下文窗口**：`RECENT.md` 控制在 ≤80 行。

---

## 4. Proposal / 方案

### 4.1 架构概述

```
  Session (主对话)
       │
       ▼
  ┌─────────────┐   14:00 & 22:00   ┌──────────────────┐
  │ memory-sync │ ──────────────────▶│ memory/YYYY-MM-DD│  (Markdown)
  │   (cron)    │ ──── NEW ────────▶│ agent-memory DB  │  (remember)
  └──────┬──────┘                    └──────────────────┘
         │ +5min
         ▼
  ┌──────────────┐   recall top-N    ┌──────────────────┐
  │memory-surface│ ◀────────────────│ agent-memory DB  │
  │   (cron)     │ ──────────────▶  │ RECENT.md        │
  └──────────────┘                   └──────────────────┘
         
  ┌─────────────┐   03:00            ┌──────────────────┐
  │ memory-tidy │ ── compress ────▶ │ weekly/ archive/  │
  │   (cron)    │ ── distill ─────▶ │ MEMORY.md         │
  │             │ ── NEW ─────────▶ │ reflect phase=all │
  └─────────────┘                    └──────────────────┘
```

**数据流方向**：Session → memory-sync → (Markdown ∥ agent-memory) → memory-surface → RECENT.md → Session。闭环。

### 4.2 方案对比

| 维度 | A: 纯 Prompt 改造（本方案） | B: agent-memory 新增 surface CLI |
|------|---------------------------|--------------------------------|
| 复杂度 | 低（只改 3 个 cron prompt） | 中（需写 `agent-memory surface` 子命令） |
| 灵活性 | 高（LLM 可自适应格式） | 中（固定模板输出） |
| 可维护性 | 中（prompt 变更需人工同步到示例） | 高（代码版本化） |
| 一致性 | 中（LLM 可能偏离格式） | 高（模板确定性输出） |
| 落地速度 | 快（今天就能改） | 慢（需开发+测试+发版） |

**选择方案 A**：v1 优先落地速度，用 prompt 约束格式。v1.1 视需要再补 CLI。

### 4.3 详细设计

#### 4.3.1 memory-sync Prompt 修改

在现有 prompt 的 **Step 5（Append to journal）之后**，新增 Step 5.5：

```markdown
### 5.5 Sync to agent-memory (best-effort)

For each NEW bullet you just appended to the journal, also write it to agent-memory.

**Classification rules (keyword-based, no LLM needed):**
- Contains 喜欢/讨厌/禁止/偏好/必须/记住/prefer/must/rule → type=knowledge
- Contains 开心/安心/难过/害羞/生气/担心/爱/想/感动/温柔/happy/sad/angry → type=emotion
- Otherwise → type=event

**For each bullet, run:**
```
exec: mcporter call agent-memory.remember \
  content="<bullet text>" \
  type=<knowledge|emotion|event> \
  uri="<type>://journal/YYYY-MM-DD#HHMM-N" \
  source="memory-sync:YYYY-MM-DD"
```

Where:
- YYYY-MM-DD = today's date
- HHMM = current time (from the section header)
- N = sequential number within section (1, 2, 3...)

**Error handling:** If mcporter call fails, log a warning and continue.
Do NOT let agent-memory failures block journal writing.

**Dedup:** agent-memory has built-in URI dedup. If a URI already exists, the call
is a no-op. Safe to retry.
```

**关键设计决策：**
- **1:1 映射**（一条 bullet = 一条 memory）：便于独立衰减和精确检索。
- **URI 作为去重键**：`event://journal/2026-02-21#2200-1` 天然幂等。
- **source 字段**：标记来源为 `memory-sync`，与手动 `remember` 区分。

#### 4.3.2 memory-tidy Prompt 修改

在现有 prompt 的 **Phase 3（Distill to MEMORY.md）的 Step 17（Wrap up）之前**，新增 Phase 4：

```markdown
[Phase 4: agent-memory Reflect]
16.5. Trigger agent-memory sleep cycle (decay + tidy + govern):
    exec: mcporter call agent-memory.reflect phase=all
    Record result in summary. If the call fails, log warning and continue.

16.6. Quick consistency spot-check (optional, skip if reflect failed):
    exec: mcporter call agent-memory.recall query="当前最重要的事" limit=3
    Compare top results with MEMORY.md content.
    If clear conflict found → mark ⚠️ CONFLICT in summary, prefer MEMORY.md as truth.
    If no conflict → record "consistency check: OK"
```

**与独立 decay cron 的关系**：本方案上线后，应移除原有的独立凌晨 4 点 reflect cron（如果存在），让 reflect 统一由 memory-tidy 在 03:00 触发，时序一致。

#### 4.3.3 memory-surface Prompt（新 Cron / 改造现有）

当前已有 `memory-surface` cron（14:05 & 22:05，在 memory-sync 后 5 分钟执行）。标准化其 prompt：

```markdown
MEMORY SURFACE — You are a memory surfacing agent. Generate RECENT.md from agent-memory.

## Steps

### 1. Fetch high-vitality memories (recent 7 days)
exec: mcporter call agent-memory.recall query="最近重要的事 情感 决策" limit=30

### 2. Fetch identity + knowledge memories
exec: mcporter call agent-memory.recall_path path="knowledge://" limit=20
exec: mcporter call agent-memory.recall_path path="emotion://" limit=10

### 3. Deduplicate and rank
From the combined results:
- Remove duplicates (same URI or >90% content overlap)
- Sort by: vitality DESC, then created_at DESC
- Keep top 40 entries max

### 4. Generate RECENT.md
Write to ~/.openclaw/workspace/RECENT.md with this exact structure:

```markdown
# RECENT.md

_auto-updated: YYYY-MM-DD HH:MM_

## 最近情感
- <emotion entries, ≤8 lines>

## 最近决策/知识
- <knowledge entries, ≤15 lines>

## 最近事件
- <event entries, ≤15 lines>
```

**Hard limits:**
- Total ≤ 80 lines (including headers and blank lines)
- Each entry: 1 line, ≤ 200 chars. Truncate if needed.
- If agent-memory returns nothing (empty DB or mcporter failure):
  fall back to reading memory/YYYY-MM-DD.md for recent 3 days and summarize.

### 5. Done
Reply ANNOUNCE_SKIP
```

**RECENT.md 生成策略要点：**

| 维度 | 规范 |
|------|------|
| 总行数上限 | 80 行（含空行和标题） |
| 分区 | 情感（≤8行）、决策/知识（≤15行）、事件（≤15行） |
| 时间窗口 | 最近 7 天 |
| 排序依据 | vitality DESC → created_at DESC |
| 降级策略 | agent-memory 不可用时，fallback 读近 3 天日记手动摘要 |
| 更新频率 | 每天 14:05 & 22:05（memory-sync 后 5 分钟） |
| 幂等性 | 每次全量覆盖 RECENT.md，不做增量 |

#### 4.3.4 Cron 时序编排

```
14:00  memory-sync     — 扫描 session → 写日记 → 同步 agent-memory
14:05  memory-surface  — 读 agent-memory → 生成 RECENT.md
22:00  memory-sync     — 同上
22:05  memory-surface  — 同上
03:00  memory-tidy     — 压缩/归档 → distill MEMORY.md → reflect(all) → consistency check
```

依赖关系：`memory-surface` 依赖 `memory-sync` 先完成（5 分钟间隔足够，sync 通常 1-2 分钟完成）。`memory-tidy` 独立运行，内含 reflect。

#### 4.3.5 URI 命名约定

```
event://journal/YYYY-MM-DD#HHMM-N      # 日记事件
emotion://journal/YYYY-MM-DD#HHMM-N    # 日记情感
knowledge://journal/YYYY-MM-DD#HHMM-N  # 日记知识/偏好
identity://core/<topic>                 # 身份认知（手动写入，P0 不衰减）
knowledge://preferences/<topic>         # 用户偏好
knowledge://lessons/<topic>             # 经验教训
```

#### 4.3.6 关键词分类规则

```python
KNOWLEDGE_KEYWORDS = [
    '喜欢', '讨厌', '禁止', '偏好', '必须', '记住', '规则', '习惯',
    'prefer', 'must', 'rule', 'always', 'never', 'remember'
]
EMOTION_KEYWORDS = [
    '开心', '安心', '难过', '害羞', '生气', '担心', '爱', '想你',
    '感动', '温柔', '幸福', '寂寞', '心疼', '甜',
    'happy', 'sad', 'angry', 'love', 'miss', 'worried'
]

def classify(text):
    if any(kw in text for kw in KNOWLEDGE_KEYWORDS): return 'knowledge'
    if any(kw in text for kw in EMOTION_KEYWORDS): return 'emotion'
    return 'event'
```

实际在 prompt 中以自然语言指令实现，LLM 按规则判断即可。

---

## 5. Risks / 风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| mcporter 调用超时/失败 | agent-memory 不写入，日记正常 | Best-effort：失败只 warn，不阻塞 Markdown 写入 |
| LLM 分类不准（event 误判为 emotion） | 衰减曲线不匹配（emotion 365d vs event 14d） | 可接受：错分只影响衰减速度，不丢数据；v1.1 可加修正 |
| memory-sync 运行时间变长（逐条 remember） | 超出 5 分钟窗口，surface 读到旧数据 | 实测单条 mcporter call <500ms，30 条 <15s；如仍超时可改为批量 |
| RECENT.md 格式漂移 | 主 session 上下文解析异常 | 硬编码模板 + 行数上限；surface prompt 严格约束格式 |
| reflect phase=all 耗时长 | memory-tidy 整体运行时间增加 | reflect 通常 <5s（纯 SQLite 操作）；放在 tidy 最后一步不影响其他 phase |
| 双重 reflect 触发（旧 cron 未移除） | 多次 decay 不会损坏数据（幂等），但浪费资源 | 文档明确要求移除旧独立 cron |

---

## 6. Test Plan / 测试方案

- [ ] **Capture 验证**：手动触发 memory-sync → 检查日记新增 N 条 bullet → `mcporter call agent-memory.status` 确认新增 N 条 memory → URI 格式正确
- [ ] **Dedup 验证**：再次触发 memory-sync（无新对话）→ agent-memory 记忆数不变（URI 去重生效）
- [ ] **Consolidate 验证**：手动触发 memory-tidy → 日志中出现 `reflect phase=all` 调用 → `agent-memory.status` 显示 decay 已执行
- [ ] **Surface 验证**：手动触发 memory-surface → `RECENT.md` 更新 → 行数 ≤ 80 → 包含三个分区 → 时间戳正确
- [ ] **Fallback 验证**：停止 agent-memory MCP → 触发 memory-sync → 日记正常写入 → 日志有 warn → 触发 memory-surface → fallback 到读日记生成
- [ ] **端到端**：在主 session 对话 → 等 14:00 sync → 等 14:05 surface → 新 session 启动 → 确认 RECENT.md 已含最新内容

---

## 7. Rollback Plan / 回滚方案

1. **Revert prompt 修改**：将三个 cron 的 prompt 恢复到修改前版本（prompt 变更应 git commit 到 `agent-memory/examples/` 目录）。
2. **RECENT.md 安全**：即使 surface 异常，RECENT.md 只是被覆盖，不影响 MEMORY.md 和日记。手动删除 RECENT.md 即可回退到无 surface 状态。
3. **agent-memory 数据**：sync 写入的数据不会影响已有记忆。如需清理，可按 `source="memory-sync:*"` 批量 forget。
4. **恢复独立 decay cron**：如果移除了旧的独立 reflect cron，回滚时需重新创建。

---

## 8. Decision Log / 决策变更记录

_实现过程中如果偏离本文档，在此记录变更原因_

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-02-21 | memory-surface 未直接在 cron prompt 内串联多次 `mcporter call`，改为调用 `~/.openclaw/workspace/scripts/memory_surface.py`，由脚本统一执行 recall/recall_path、去重、排序、fallback、写 RECENT.md | 降低 prompt 漂移风险，保证 `RECENT.md` 结构和 80 行上限稳定；便于后续维护与调试 |
| 2026-02-21 | `recall_path` 参数由设计稿中的 `path=` 调整为 `uri=` | 实际 MCP 工具 schema 要求 `uri` 字段；`path` 会触发参数校验错误 |
| 2026-02-21 | memory-tidy 保留现网 `MEMORY.md` 200 行上限，仅补充 Phase 4 reflect+consistency，不回退到 80 行 | 避免对现有长期记忆容量策略造成行为回退；本 DD 目标聚焦于 Markdown × agent-memory 融合链路 |
| 2026-02-21 | 额外补充 `~/.openclaw/openclaw.json` 的 `cron` 配置块（enabled/store/maxConcurrentRuns/sessionRetention） | 使 cron 持久化位置与并发参数显式化，便于运维核对与后续迁移 |

---

## Appendix A: 现有 Cron Prompt 完整修改 Diff

### memory-sync：新增 Step 5.5

位置：在 `### 5. Append to journal` 之后、`### 6. Done` 之前插入。

### memory-tidy：新增 Phase 4

位置：在 `[Phase 3: Distill to MEMORY.md]` 的 Step 16 之后、`[Wrap up]` Step 17 之前插入。

### memory-surface：完整新 prompt

见 §4.3.3，替换现有 memory-surface cron 的 prompt。

---

_Generated by DD workflow · Claude Opus sub-agent_
