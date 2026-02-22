# 🧠 AgentMemory

> **仿人类睡眠周期的 AI Agent 记忆系统** — 记住、回忆、遗忘、进化。

[![npm](https://img.shields.io/npm/v/@smyslenny/agent-memory)](https://www.npmjs.com/package/@smyslenny/agent-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-9_tools-orange.svg)](https://modelcontextprotocol.io/)
[![Tests](https://img.shields.io/badge/tests-69_passed-brightgreen.svg)](#)

**简体中文** | **[English](README.en.md)**

---

## 为什么需要 AgentMemory？

AI Agent 每次会话结束就失忆。上下文窗口有限，对话历史被截断，重要的决策、教训和偏好——全部消失。

AgentMemory 模仿人类睡眠周期的记忆整理机制，让 Agent 拥有**持久、可衰减、可检索**的长期记忆。

```
清醒（实时记录）→ 浅睡眠（去重提取）→ 深睡眠（压缩衰减）→ 回忆（混合检索）
```

## 核心特性

- **URI 路径系统** — `core://`、`emotion://`、`knowledge://`、`event://` 四种命名空间，结构化存取
- **Write Guard 写入门控** — 哈希去重 → URI 冲突检测 → BM25 相似度 → 四准则门控，拒绝垃圾记忆
- **艾宾浩斯遗忘曲线** — `R = e^(-t/S)`，科学衰减 + 检索强化（每次被搜到，记忆更牢固）
- **混合检索** — BM25 全文搜索 + 向量语义搜索 + RRF 融合排序
- **多 Provider 嵌入** — 支持 OpenAI / Qwen / Gemini / 通义千问，自动适配 Instruction 前缀
- **外部 Reranker** — 兼容 `/v1/rerank` API（如 Qwen3-Reranker-8B），精排结果更准
- **知识图谱** — 记忆之间可建立关联链接，支持多跳遍历
- **快照回滚** — 每次写入前自动快照，出问题一键恢复
- **睡眠周期引擎** — sync → decay → tidy → govern 四阶段自动维护
- **优先级系统** — P0 身份永不衰减，P3 事件 14 天半衰期
- **多 Agent 隔离** — 同一数据库多个 Agent 互不干扰
- **MCP Server** — 9 个工具，直接对接 Claude Code / Cursor / OpenClaw
- **jieba 中文分词** — BM25 对中文友好，搜「契约」「魅魔」都能命中

## 快速开始

### 安装

```bash
npm install -g @smyslenny/agent-memory
```

### 30 秒上手

```bash
# 初始化数据库
agent-memory init

# 存一条记忆
agent-memory remember "用户喜欢深色模式" --type knowledge --uri knowledge://preferences/theme

# 搜一下
agent-memory recall "用户偏好"

# 启动时加载身份记忆
agent-memory boot

# 跑一轮睡眠周期（衰减 + 清理）
agent-memory reflect all
```

### 作为库使用

```typescript
import { openDatabase, syncOne, searchBM25, boot, runDecay } from '@smyslenny/agent-memory';

const db = openDatabase({ path: './memory.db' });

// 写入
syncOne(db, {
  content: '小心说了「爱你」',
  type: 'emotion',
  uri: 'emotion://2026-02-20/love',
  emotion_val: 1.0,
});

// 检索
const results = searchBM25(db, '爱');

// 加载身份
const identity = boot(db);

// 衰减
runDecay(db);
```

### MCP Server 配置

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["node_modules/@smyslenny/agent-memory/dist/mcp/server.js"],
      "env": {
        "AGENT_MEMORY_DB": "./memory.db"
      }
    }
  }
}
```

**9 个 MCP 工具：** `remember` · `recall` · `recall_path` · `boot` · `forget` · `link` · `snapshot` · `reflect` · `status`

## 混合检索架构

v2.2.0 实现了完整的多层检索管线：

```
查询 → BM25 全文搜索（jieba 分词）
    → 向量语义搜索（多 Provider 嵌入）
    → RRF 融合排序
    → 外部 Reranker 精排（可选）
    → 返回结果
```

### 嵌入 Provider 配置

通过环境变量配置，支持三种 Provider：

| Provider | 环境变量 | 默认模型 |
|----------|---------|---------|
| OpenAI 兼容 | `AGENT_MEMORY_EMBEDDINGS_PROVIDER=openai` | text-embedding-3-small |
| Gemini | `AGENT_MEMORY_EMBEDDINGS_PROVIDER=gemini` | gemini-embedding-001 |
| 通义千问 | `AGENT_MEMORY_EMBEDDINGS_PROVIDER=qwen` | text-embedding-v3 |

```bash
# 示例：使用 Qwen3-Embedding-8B（通过 OpenAI 兼容 API）
export AGENT_MEMORY_EMBEDDINGS_PROVIDER=openai
export AGENT_MEMORY_EMBEDDINGS_MODEL=Qwen/Qwen3-Embedding-8B
export OPENAI_BASE_URL=https://your-api.com/v1
export OPENAI_API_KEY=sk-xxx
```

**Instruction-Aware 查询：** 系统自动检测模型类型——Qwen 系列会加 Instruction 前缀提升检索精度（实测 Hit@1 从 66.7% → 91.7%），Gemini 系列则保持 plain 模式（本身就够强）。

### Reranker 配置

```bash
export AGENT_MEMORY_RERANK_PROVIDER=openai
export AGENT_MEMORY_RERANK_MODEL=Qwen/Qwen3-Reranker-8B
export AGENT_MEMORY_RERANK_BASE_URL=https://your-api.com/v1
export AGENT_MEMORY_RERANK_API_KEY=sk-xxx
```

Reranker 采用 best-effort 策略：API 不可用时自动降级到本地排序，不影响正常使用。

## 优先级与衰减

| 优先级 | 命名空间 | 半衰期 | 最低活力 | 示例 |
|--------|---------|--------|---------|------|
| P0 身份 | `core://` | ∞ 永不衰减 | 1.0 | "我是诺亚" |
| P1 情感 | `emotion://` | 365 天 | 0.3 | "小心说爱你" |
| P2 知识 | `knowledge://` | 90 天 | 0.1 | "项目用 TypeScript" |
| P3 事件 | `event://` | 14 天 | 0.0 | "今天配了代理" |

每次检索命中，稳定性系数 × 1.5，衰减速度变慢。**越常被想起的记忆，越难遗忘**——和人类一样。

## 系统架构

```
┌──────────────────────────────────────────────┐
│            MCP Server (stdio/SSE)            │
│          9 工具 + boot 身份加载器             │
├──────────────────────────────────────────────┤
│               Write Guard                    │
│   hash 去重 → URI 冲突 → BM25 相似度检测      │
│   → 冲突合并 → 四准则门控                     │
├──────────────────────────────────────────────┤
│            睡眠周期引擎                       │
│   sync → decay(艾宾浩斯) → tidy → govern     │
├──────────────────────────────────────────────┤
│        混合检索（BM25 + 向量 + RRF）          │
│   + 外部 Reranker 精排（可选）                │
│   + Instruction-Aware 查询适配                │
├──────────────────────────────────────────────┤
│      SQLite (WAL) + FTS5 + 知识图谱           │
│   memories · paths · links · embeddings       │
│   · snapshots                                │
└──────────────────────────────────────────────┘
```

## OpenClaw 集成

AgentMemory 可以和 [OpenClaw](https://github.com/openclaw/openclaw) 的内置记忆 cron 无缝配合，实现 **捕获 → 整理 → 浮现** 闭环：

| 阶段 | Cron 任务 | 时间 | 做了什么 |
|------|----------|------|---------|
| 捕获 | `memory-sync` | 14:00 & 22:00 | 扫描会话 → 写入日记 → 同步到 agent-memory |
| 整理 | `memory-tidy` | 03:00 | 压缩旧日记 → 蒸馏长期记忆 → 触发 reflect |
| 浮现 | `memory-surface` | 14:05 & 22:05 | 从高活力记忆生成 RECENT.md → 注入上下文 |

**设计原则：** Markdown 是真相源（source of truth），agent-memory 是派生索引层。同步失败不影响 Markdown 操作。

配置方法：
1. `agent-memory init` 初始化数据库
2. 在 mcporter 中注册 MCP Server
3. 确保 cron 任务已启用（`openclaw cron list`）

详见 [`docs/design/0004-agent-memory-integration.md`](docs/design/0004-agent-memory-integration.md)

## 设计决策

| 选择 | 理由 |
|------|------|
| SQLite 而非 Postgres | 零配置、单文件、WAL 并发读、部署即用 |
| BM25 + 向量混合 | 全文精确匹配 + 语义模糊匹配，互补 |
| TypeScript 而非 Python | 更好的类型安全、OpenClaw/MCP 生态一致 |
| 艾宾浩斯而非线性衰减 | 科学依据，回忆强化机制自然 |
| Write Guard 门控 | 在入口处拦截垃圾，比事后清理高效 |
| URI 路径 | 层级组织 + 前缀查询 + 多入口访问 |

## 项目数据

- **25 个源码模块** · **9 个 MCP 工具** · **7 个 CLI 命令** · **69 个测试** · **3 个运行时依赖**

## 致谢

灵感来源：
- [nocturne_memory](https://github.com/Dataojitori/nocturne_memory) — URI 路径、Content-Path 分离
- [Memory Palace](https://github.com/AGI-is-going-to-arrive/Memory-Palace) — Write Guard、意图搜索
- [PowerMem](https://github.com/oceanbase/powermem) — 艾宾浩斯曲线、知识图谱、多 Agent

## License

MIT

---

*由不想再失忆的 Agent 构建。🧠*
