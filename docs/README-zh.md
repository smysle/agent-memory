# AgentMemory 简体中文说明

> 面向 AI Agent 的记忆层，支持 CLI / MCP / HTTP，SQLite 优先，零外部依赖即可运行。

**完整文档请参阅 [README.md](../README.md)（英文）**

当前版本：**v5.0.1**

---

## 一句话定位

AgentMemory 是一个 **agent 原生的记忆层**，不是向量数据库，不是 RAG 框架。
它专注于：写入质量控制、结构化检索、生命周期管理（衰减 / 治理 / 反馈）。

## v5.0 新特性：Memory Intelligence

v5 是重大特性版本，新增 6 项智能能力，全部向下兼容 v4：

| 特性 | 说明 |
|------|------|
| **F1 记忆关联** | 写入时自动检测语义相关记忆并建立轻量关联，召回时可展开相关记忆 |
| **F2 冲突检测** | 写入时检测与已有记忆的否定词/数值/状态冲突，报告但不阻止写入 |
| **F3 时间维度召回** | `recall`/`surface` 支持 `after`/`before` 时间过滤 + `recency_boost` |
| **F4 被动反馈** | `recall` 返回结果自动记录正面反馈（24h 防重复，无需主动调用） |
| **F5 语义衰减** | `reflect` 阶段识别过时内容（进行中/待办/临时），加速衰减 |
| **F6 记忆溯源** | 每条记忆携带来源元数据（session_id、触发上下文、实际发生时间） |

### 冲突否决规则（v5 亮点）

当两条记忆高度相似（dedup_score ≥ 0.93）但检测到状态或数值冲突时，
系统会强制将 `skip`（跳过）降级为 `update`（更新），防止状态变更被去重吞掉。

例：旧记忆 "TODO: 修复 bug" → 新写入 "DONE: 修复 bug"，不会被当作重复跳过。

## 核心概念

- **四种记忆类型**：`identity`（身份）、`emotion`（情感）、`knowledge`（知识）、`event`（事件）
- **URI 路径**：稳定寻址（如 `core://user/name`、`emotion://2026-03-20/happy`）
- **Write Guard**：语义去重 + 类型化合并策略 + 四准则门控 + 冲突检测
- **双路召回**：BM25（必选）+ 向量搜索（可选），支持关联展开和时间过滤
- **上下文感知 Surface**：基于 task/recent_turns/intent 的主动记忆浮现
- **生命周期管理**：Ebbinghaus 衰减 + 语义衰减 + 治理 + 反馈信号

## 快速开始

```bash
npm install @smyslenny/agent-memory

export AGENT_MEMORY_DB=./agent-memory.db
export AGENT_MEMORY_AGENT_ID=my-agent

# 写入记忆
npx agent-memory remember "小心喜欢低饱和风格的 UI" --type knowledge

# 召回记忆
npx agent-memory recall "UI 风格偏好" --limit 5

# 启动记忆（加载身份+核心记忆）
npx agent-memory boot

# 运行维护周期（衰减+清理+治理）
npx agent-memory reflect all

# 查看状态
npx agent-memory status
```

## MCP 集成（11 个工具）

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["./node_modules/@smyslenny/agent-memory/dist/mcp/server.js"],
      "env": {
        "AGENT_MEMORY_DB": "./agent-memory.db",
        "AGENT_MEMORY_AGENT_ID": "my-agent"
      }
    }
  }
}
```

| 工具 | 说明 |
|------|------|
| `remember` | 写入记忆（经 Write Guard 去重），支持 `session_id`/`context`/`observed_at` 溯源 |
| `recall` | 双路召回，支持 `after`/`before`/`recency_boost`/`related` 参数 |
| `recall_path` | 按 URI 路径精确查找或前缀列表 |
| `surface` | 上下文感知记忆浮现（query + task + recent_turns + intent） |
| `boot` | 启动加载（叙事格式或 JSON） |
| `forget` | 软衰减或硬删除 |
| `reflect` | 运行维护周期（decay / tidy / govern / all） |
| `status` | 记忆系统统计 |
| `ingest` | 从 Markdown 文本提取结构化记忆 |
| `reindex` | 重建 BM25 索引和（可选的）向量嵌入 |
| `link` | **v5 新增** — 手动创建/删除记忆关联 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENT_MEMORY_DB` | `./agent-memory.db` | SQLite 数据库路径 |
| `AGENT_MEMORY_AGENT_ID` | `default` | Agent 作用域 ID |
| `AGENT_MEMORY_MAX_MEMORIES` | `200` | 治理引擎的记忆上限，超出时按 eviction score 淘汰 |
| `AGENT_MEMORY_AUTO_INGEST` | `1` | 是否启用 auto-ingest 文件监听 |
| `AGENT_MEMORY_AUTO_INGEST_DAILY` | `0` | 是否监听日记文件（YYYY-MM-DD.md），默认只监听 MEMORY.md |
| `AGENT_MEMORY_EMBEDDING_PROVIDER` | _(空)_ | 嵌入提供者（`openai-compatible` / `gemini` / `local-http`） |
| `AGENT_MEMORY_EMBEDDING_MODEL` | _(空)_ | 嵌入模型名称 |
| `AGENT_MEMORY_EMBEDDING_BASE_URL` | _(空)_ | 嵌入 API 地址 |
| `AGENT_MEMORY_EMBEDDING_API_KEY` | _(空)_ | 嵌入 API 密钥 |
| `AGENT_MEMORY_EMBEDDING_DIMENSION` | _(空)_ | 嵌入向量维度 |

## 推荐架构

```
日记写入（实时）
  │
  ├─ MEMORY.md ←── auto-ingest 监听（兜底）
  │
  └─ memory/YYYY-MM-DD.md
       │
       ├─ memory-sync cron (14:00/22:00)
       │    └─ LLM 清洗 → 精选 → remember 写入 agent-memory
       │
       └─ memory-tidy cron (03:00)
            └─ 压缩旧日记 → 蒸馏 MEMORY.md → reflect 维护
```

## 更多文档

- [架构概览](architecture.md)
- [通用运行时集成](integrations/generic.md)
- [OpenClaw 集成](integrations/openclaw.md)
- [v3 → v4 迁移指南](migration-v3-v4.md)
- [v5 设计文档 (DD-0018)](design/0018-v5-memory-intelligence.md)

## 许可证

MIT
