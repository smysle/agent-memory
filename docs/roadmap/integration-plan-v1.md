# Markdown × AgentMemory 融合方案（v1）

> 目标：把「自动加载的 Markdown 记忆」和「可衰减/可搜索/可关联的 agent-memory」融合为一条轻量数据管线。
> 
> 核心原则：**Markdown 负责在场（可读/可编辑/自动注入）**；**agent-memory 负责智能（结构化/衰减/图谱/混合搜索）**。

---

## 0. 我们到底要解决什么（非重复版）

- 现在**醒来已有**：SOUL/USER/MEMORY.md 自动注入；daily notes 可读。
- 但 agent-memory **不会自动参与**：它像“外挂脑子”，要手动 recall/remember。

**真正缺口：**
1) 自动捕获的数据只进 Markdown，不进 agent-memory → agent-memory 的衰减/向量/图谱能力用不上。
2) agent-memory 的“新鲜记忆”不会浮到表面 → MEMORY.md 更新滞后。

**因此 v1 的目标不是 Warm Boot，而是：**
> **把 capture→consolidate→surface 这条链打通，让两边同一份事实。**

---

## 1. 定位（Source of Truth）

### v1 选择：Markdown 为主，agent-memory 为索引/智能层（派生）
- Markdown：人类可读、可手动修正、OpenClaw 自动加载，是“对外呈现”。
- agent-memory：从 Markdown/对话“同步得到”，提供搜索/衰减/关联/统计，是“对内智能”。

> 这样最轻量：不改你现有的记忆工作流，只是让 agent-memory **跟着走**。

---

## 2. 融合管线（v1）

### Phase 1（P0）：打通数据流（最轻量，先做这个）

#### 2.1 Capture：memory-sync 同步写入 agent-memory
**改动点：**只改 OpenClaw cron `memory-sync` 的 prompt（不改 agent-memory 代码）。

**做法：**
- memory-sync 在“把新条目追加到 `memory/YYYY-MM-DD.md`”之后：
  - 对每条“新增 bullet”同时调用：
    - `mcporter call agent-memory.remember ...`
  - 让 agent-memory 与日记增量保持一致。

**推荐字段约定：**
- `source`: `memory-sync:YYYY-MM-DD`
- `uri`：
  - event：`event://journal/YYYY-MM-DD#HHMM-N`
  - emotion：`emotion://journal/YYYY-MM-DD#HHMM-N`
  - knowledge：`knowledge://journal/YYYY-MM-DD#HHMM-N`

**轻量分类规则（无需 LLM）：**
- 包含“喜欢/讨厌/禁止/偏好/必须/记住”→ knowledge
- 包含“开心/安心/难过/害羞/生气/担心/爱你/想你”→ emotion
- 其余默认 event

> 注意：memory-sync 本身已经是 LLM 任务；我们只是让它在写 Markdown 的同时，顺手把同一条写进 agent-memory。

#### 2.2 Consolidate：memory-tidy 触发 agent-memory reflect
**改动点：**在 `memory-tidy` cron 的收尾步骤追加：
- `mcporter call agent-memory.reflect phase=all`

目的：
- 让衰减/治理与 Markdown 的“深度睡眠整理”同步发生。

#### 2.3 Surface：生成一个“自动注入”的新文件（而不是 Warm Boot）
**新增一个文件：** `RECENT.md`（或 `BOOT.md`）放在 workspace 根目录。

**内容来源：**agent-memory 里“最近 7 天 + vitality 高”的记忆。

**生成频率：**
- 每次 memory-sync 结束生成一次（或每天 08:00 一次）

**为什么要这个：**
- 让 agent-memory 的“最新变化”进入自动上下文。
- 不动 MEMORY.md 的 200 行硬上限；RECENT.md 专门放“最近”。

---

## 3. 具体交付（v1）

### 3.1 OpenClaw 侧（配置/cron）
- [ ] patch `memory-sync` prompt：追加“新增 bullet → remember(含 type/uri/source)”
- [ ] patch `memory-tidy` prompt：收尾 reflect
- [ ] 新增 cron：`memory-surface`（或挂在 memory-sync 收尾）生成 `RECENT.md`

### 3.2 agent-memory 侧（尽量少改）
v1 **可以零代码**（cron 直接 mcporter remember + reflect）。

但为了更干净，v1.1 可以加 2 个小命令（都很轻）：
- [ ] `agent-memory surface --out RECENT.md --days 7 --limit 50`：输出 markdown
- [ ] `agent-memory embed:missing`：批量补 embeddings（有 key 才跑）

---

## 4. 验收标准（Definition of Done）

1) 跑一次 memory-sync：
- 日记新增条目数 = agent-memory 新增条目数（允许少量被 guard 去重）

2) `RECENT.md` 自动更新：
- 包含：最近情感/事件/偏好
- 总长度受控（建议 <= 150 行）

3) 多 agent 隔离：
- 同一 DB 下不同 `AGENT_MEMORY_AGENT_ID` 不互相污染（已在 schema v2/v3 做到）

4) 失败不炸：
- mcporter 调用失败 → 只警告，不影响日记写入（best-effort）

---

## 5. 风险与轻量化策略

- **不引入新依赖**：v1 不加包。
- **不新增新模型**：surface 纯模板拼接；分类用规则。
- **不扩大上下文**：RECENT.md 受限行数 + 只放最近/高 vitality。
- **不泄密**：sync 写入前做简单过滤（形如 `sk-` 的 token / 私钥头）直接拒写。

---

## 6. v2（以后再说，不急）

- 统一检索入口：qmd(memory_search) + agent-memory(recall) RRF 合并
- 自动 links：新记忆写入后用相似度建“related”边
- 情感标签体系：emotion_tag（安心/成就感/担心…）+ 趋势统计

---

## 7. 需要小心拍板的 3 个选项

1) `RECENT.md` 叫啥？（RECENT / BOOT / CONTEXT）
2) surface 输出的窗口：7 天还是 3 天？默认 7 天更稳。
3) memory-sync 同步时：一条 bullet 一条 memory？还是合并成一个块？（我建议 1:1，便于衰减和检索）

---

_这版才是“结合起来”的轻量方案：不重复系统提示已有的记忆，而是把 agent-memory 的能力接进现有 cron，让它不再是孤岛。_
