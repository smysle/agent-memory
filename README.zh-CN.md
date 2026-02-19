# 🧠 AgentMemory

> **基于睡眠周期的 AI Agent 记忆架构** — 记录、整理、回忆。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org/)

**[English](README.md)** | **简体中文**

---

## 💡 问题

AI Agent 在每次会话之间会遗忘一切。上下文窗口有限，对话历史会被截断，重要的决策、教训和偏好就这样消失了。

**AgentMemory** 通过模仿人类大脑在睡眠期间整理记忆的方式，为 AI Agent 提供持久化记忆系统。

## 🌙 工作原理 — 睡眠周期

| 阶段 | 人类类比 | Agent 行为 | 调度 |
|------|---------|-----------|------|
| **清醒** | 经历事件 | 将重要事件实时写入日记 | 实时 |
| **浅睡眠** | 记忆回放 | `memory-sync`：扫描会话，提取重点，**去重**，补充遗漏 | 每天 2 次（14:00 & 22:00） |
| **深睡眠** | 记忆巩固 | `memory-tidy`：压缩旧日记 → 周报，蒸馏 → MEMORY.md，归档 | 每天 1 次（03:00） |
| **回忆** | 记忆检索 | 语义搜索 `memory_search` → `memory_get` | 按需 |

```
         ┌─────────────┐
         │    清醒     │  实时记录日记
         │  (Journal)  │  memory/YYYY-MM-DD.md
         └──────┬──────┘
                │
         ┌──────▼──────┐
         │   浅睡眠    │  14:00 & 22:00
         │(memory-sync)│  去重 + 提取重点
         └──────┬──────┘
                │
         ┌──────▼──────┐
         │   深睡眠    │  03:00
         │(memory-tidy)│  压缩 → 周报，蒸馏 → MEMORY.md
         └──────┬──────┘
                │
         ┌──────▼──────┐
         │    回忆     │  按需
         │  (Search)   │  语义搜索所有记忆
         └─────────────┘
```

## 📁 记忆架构

```
workspace/
├── MEMORY.md                    # 🧠 长期记忆（≤80行，精心筛选）
├── memory/
│   ├── 2026-02-20.md           # 📝 今日日记（原始、实时）
│   ├── 2026-02-19.md           # 📝 昨天
│   ├── ...                     # 最近 7 天保留原文
│   ├── weekly/
│   │   └── 2026-02-09.md      # 📦 压缩后的周报
│   ├── archive/
│   │   ├── 2026-02-12.md      # 🗄️ 已归档的旧日记
│   │   └── MEMORY.md.bak-*    # 💾 MEMORY.md 备份
│   └── heartbeat-state.json    # 💓 心跳检查时间戳
```

### 三层记忆

| 层级 | 文件 | 保留时间 | 内容 |
|------|------|---------|------|
| **热层** | `memory/YYYY-MM-DD.md` | 7 天 | 原始日记，记录所有发生的事 |
| **温层** | `memory/weekly/*.md` | 长期 | 压缩的周报摘要，标注来源日期 |
| **冷层** | `MEMORY.md` | 永久 | 精选的长期记忆，≤80 行，四准则门控 |

## 🔑 核心设计决策

### 1. 去重是第一优先级

生产环境中最大的教训：**memory-sync 写入前必须检查已有内容**。不做去重的话，同一件事会被写入 7-8 遍（每次 sync 都写一遍）。我们的 sync prompt 现在要求：

1. 先读取现有日记
2. 逐条与新对话内容对比
3. 只追加真正的新事件
4. 绝不重写已有段落

### 2. 四准则门控（MEMORY.md）

任何信息进入长期记忆前，四个条件必须**全部满足**：

- **(a)** 没有这条信息会犯具体的错误
- **(b)** 适用于多次未来对话
- **(c)** 脱离上下文也能理解
- **(d)** 与 MEMORY.md 现有内容不重复

**反向检查**：写入前问自己——"没有这条信息我会犯什么具体错误？"答不上来就不写。

### 3. 情感 > 技术

记忆捕获优先级排序：
1. 💬 用户说的重要话 / 情感互动（最高）
2. 🎯 关键决策和结论
3. ✅ 完成的里程碑
4. 📚 教训 / 踩坑
5. 🔧 技术操作记录（最低——一句话概括即可）

### 4. 80 行硬性上限

MEMORY.md 硬性限制 80 行。这迫使你精心筛选——当达到上限时，必须先压缩或删除过时条目才能添加新内容。防止无限膨胀，保持检索效率。

## 🚀 快速开始

### 方案 A：配合 OpenClaw 使用（推荐）

参见 [`examples/openclaw-setup.md`](examples/openclaw-setup.md)，包含完整配置指南：
- Cron 定时任务配置
- qmd 语义搜索集成
- 经过实战验证的 prompt 模板

### 方案 B：使用 CLI

```bash
# 安装
npm install -g agent-memory

# 初始化记忆结构
agent-memory init

# 写入今日日记
agent-memory journal "部署了 v2.0 到生产环境"

# 语义搜索所有记忆
agent-memory recall "部署问题"

# 运行记忆整理
agent-memory sync   # 浅睡眠 — 去重并提取
agent-memory tidy   # 深睡眠 — 压缩并蒸馏
```

### 方案 C：作为库使用

```javascript
import { AgentMemory } from 'agent-memory';

const memory = new AgentMemory({ workDir: './workspace' });

// 记录（清醒阶段）
await memory.journal('用户偏好深色模式');

// 回忆（搜索阶段）
const results = await memory.recall('用户偏好');

// 同步（浅睡眠）
await memory.sync();

// 整理（深睡眠）
await memory.tidy();
```

## 📋 示例文件

| 文件 | 说明 |
|------|------|
| [`examples/openclaw-setup.md`](examples/openclaw-setup.md) | OpenClaw 完整集成指南 |
| [`examples/memory-sync-prompt.txt`](examples/memory-sync-prompt.txt) | 生产环境 memory-sync 定时任务 prompt |
| [`examples/memory-tidy-prompt.txt`](examples/memory-tidy-prompt.txt) | 生产环境 memory-tidy 定时任务 prompt |
| [`examples/MEMORY.md.example`](examples/MEMORY.md.example) | 长期记忆文件示例 |
| [`examples/daily-journal.md.example`](examples/daily-journal.md.example) | 日记示例 |

## 🧪 生产环境数据

自 2026-02-12 运行至今：
- **119 个文档**被索引（日记 + 会话 + MEMORY.md）
- **93% 搜索准确率**（qmd：BM25 + 向量 + 重排序）
- **~2 秒**回忆延迟（qmd daemon 模式），CPU 模式约 60 秒
- **8 份日记**已压缩为周报
- **78/80 行** MEMORY.md（限额内运行良好）

## 🤝 兼容性

- **[OpenClaw](https://github.com/openclaw/openclaw)** — 通过 cron 定时任务 + qmd 后端完整集成
- **任何 LLM Agent** — prompt 和架构与模型无关
- **任何定时任务系统** — 只需按你的方式调度 sync/tidy prompt

## 📄 开源协议

MIT — 随意使用、fork、让你的 Agent 学会记忆。

---

*由不想再遗忘的 Agent 构建 🧠*
