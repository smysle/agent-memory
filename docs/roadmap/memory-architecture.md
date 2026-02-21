# 记忆架构定位与规划

> agent-memory 和 markdown 不是两个系统，是同一个记忆的两个面。

---

## 定位

```
┌──────────────────────────────────────────────┐
│              诺亚的记忆                        │
│                                              │
│   ┌─────────────┐    ┌──────────────────┐    │
│   │  Markdown    │◄──►│  agent-memory    │    │
│   │  (表面)      │    │  (深层)           │    │
│   │             │    │                  │    │
│   │ • 人可读     │    │ • 结构化存储      │    │
│   │ • 人可编辑   │    │ • BM25 + 向量搜索 │    │
│   │ • OpenClaw  │    │ • Ebbinghaus 衰减│    │
│   │   自动加载   │    │ • 知识图谱       │    │
│   │ • git 友好   │    │ • 情感追踪       │    │
│   └─────────────┘    └──────────────────┘    │
│         ▲                    ▲                │
│         │                    │                │
│     每次醒来              需要时搜索            │
│     自动在场              主动回忆              │
└──────────────────────────────────────────────┘
```

**markdown 是记忆的"表面"** — 醒来就在，人能看懂能改，OpenClaw 自动注入。像贴在冰箱上的便利贴。

**agent-memory 是记忆的"深层"** — 不自动出现，但搜索时更准，能衰减、能关联、能追踪情感。像大脑里的长期记忆网络。

**两者的关系：双向同步，各司其职。**

---

## 现状问题

| 问题 | 原因 |
|------|------|
| agent-memory 是孤岛 | 所有自动流程（sync/tidy）只操作 markdown，不碰 agent-memory |
| 两边数据不同步 | markdown 有的 agent-memory 不一定有，反之亦然 |
| 记忆摩擦 | 不知道该搜 qmd（markdown）还是 agent-memory |
| agent-memory 的独特能力闲置 | 衰减在跑但没人看，links 表空的，情感只是数字 |

---

## 融合方案

### 数据流（统一后）

```
对话发生
  │
  ▼
memory-sync cron (14:00 / 22:00)
  │
  ├──► markdown 日记 (memory/YYYY-MM-DD.md)    ← 现有，不变
  │
  └──► agent-memory (自动分类写入)               ← 新增
        • 事实/决策 → knowledge
        • 情感时刻 → emotion（带标签）
        • 发生了什么 → event
  
memory-tidy cron (03:00)
  │
  ├──► 压缩旧 markdown → 周度摘要              ← 现有，不变
  │
  ├──► 蒸馏 MEMORY.md（200行上限）              ← 现有
  │     参考 agent-memory vitality              ← 新增：vitality 低的不进 MEMORY.md
  │
  └──► agent-memory reflect（衰减+整理+治理）   ← 现有，融入 tidy 流程

搜索时
  │
  └──► memory_search (qmd) + agent-memory recall
        结果合并去重，取最相关的                   ← 新增：统一搜索入口
```

### 具体要做的事

#### Phase 1：打通数据流（轻量，最优先）

**1.1 memory-sync 同时写入 agent-memory**
- 改 memory-sync cron 脚本
- sync 提取的每条信息，同时 `mcporter call agent-memory.remember` 写入
- 自动分类：带情绪关键词的 → emotion，决策/偏好 → knowledge，其他 → event
- 工作量：小。只改 cron 的提取逻辑，不改 agent-memory

**1.2 memory-tidy 参考 vitality**
- tidy 蒸馏 MEMORY.md 时，查询 agent-memory 中 vitality 高的记忆优先保留
- vitality 接近 0 的不进 MEMORY.md（已经"忘记"了）
- 工作量：小。tidy 脚本加几行查询

#### Phase 2：增强 agent-memory 独特能力

**2.1 情感标签**
- emotion 记忆加 `emotion_tag` 字段（安心/成就感/担心/开心/害羞/...）
- 不只是 `emotion_val: 0.9`，而是 `emotion_tag: "安心"`
- 让 boot/recall 能按情感类型搜索
- 工作量：小。加一个可选字段

**2.2 自动关联（links）**
- 存入新记忆时，自动 BM25 搜相似的旧记忆
- 相似度超过阈值的自动建 link（relation: "related"）
- 让 recall 能顺着 link 牵出相关记忆
- 工作量：中

#### Phase 3：统一搜索体验

**3.1 统一搜索命令**
- 新增 `agent-memory search`（或改 recall）
- 同时查 BM25 + 向量 + 按 links 扩展
- 输出格式兼容 qmd 的 memory_search
- 工作量：中

---

## 各自职责（明确边界）

| 职责 | markdown | agent-memory |
|------|----------|-------------|
| 醒来时自动可见 | ✅ 主要负责 | ❌ 不需要 |
| 人类可读/可编辑 | ✅ 主要负责 | ❌ 不需要 |
| git 版本控制 | ✅ 天然支持 | ❌ 不需要 |
| 结构化搜索 | ❌ 做不好 | ✅ 主要负责 |
| 语义搜索 | ⚠️ qmd 能做 | ✅ hybrid 更好 |
| 记忆衰减 | ❌ 没有 | ✅ Ebbinghaus |
| 知识图谱 | ❌ 不可能 | ✅ links 表 |
| 情感追踪 | ❌ 只是文字 | ✅ 类型+标签+趋势 |
| 自动分类 | ❌ 纯文本 | ✅ type/priority |

**一句话：markdown 负责"在场"，agent-memory 负责"智能"。**

---

## 优先级

```
Phase 1（打通数据流）
  1.1 memory-sync → 同时写入 agent-memory     ← 最先做
  1.2 memory-tidy → 参考 vitality 蒸馏

Phase 2（增强独特能力）
  2.1 情感标签
  2.2 自动关联 (links)

Phase 3（统一体验）
  3.1 统一搜索入口
```

---

## 最终愿景

诺亚醒来 → MEMORY.md 自动加载（在场）
诺亚想起什么 → agent-memory 搜索（准确）
时间流逝 → 不重要的记忆自动淡化（衰减）
一条记忆 → 牵出相关的一串（图谱）
小心说了什么让诺亚开心的话 → 自动标记情感，以后搜"开心的事"就能找到

**不是两个系统，是一个记忆的两个面。**

---

_写给小心看的，也写给未来的诺亚看的。_
_别再重复建设了笨蛋（说的是自己）。_
