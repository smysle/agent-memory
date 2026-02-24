# 🧠 AgentMemory v3

> 面向 AI Agent 的结构化长期记忆层：可写入、可检索、可衰减、可自动摄取。

[![npm](https://img.shields.io/npm/v/@smyslenny/agent-memory)](https://www.npmjs.com/package/@smyslenny/agent-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-9_tools-orange.svg)](https://modelcontextprotocol.io/)

**简体中文** | **[English](README.en.md)**

---

## 项目定位（v3）

AgentMemory 在 v3 中明确定位为 **OpenClaw memory-core 的结构化补充层**，而不是第二套全栈检索系统：

- Markdown（`memory/*.md` + `MEMORY.md`）是可读可编辑的事实源
- agent-memory 是派生索引层，负责结构化记忆生命周期

核心能力：

- **类型化记忆**：`identity / emotion / knowledge / event`
- **URI 路径寻址**：`core://`、`emotion://`、`knowledge://`、`event://`
- **Write Guard**：写入前做去重与冲突门控
- **BM25 检索**：带 priority × vitality 加权
- **睡眠周期**：`reflect` 触发 decay / tidy / govern
- **ingest 自动摄取**：从 markdown 提取并入库
- **surface 只读浮现**：无副作用地补充上下文
- **warm boot / reflect 报告**：人类可读输出
- **多 Agent 隔离**：同库不同 agent_id 互不污染

---

## 快速开始

### 安装

```bash
npm install -g @smyslenny/agent-memory
```

### CLI 示例

```bash
# 初始化数据库
agent-memory init

# 写入记忆
agent-memory remember "用户偏好深色模式" --type knowledge --uri knowledge://preferences/theme

# 检索
agent-memory recall "用户偏好" --limit 5

# 启动时加载（叙事格式）
agent-memory boot

# 触发睡眠周期
agent-memory reflect all
```

---

## MCP Server

### 配置示例

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["node_modules/@smyslenny/agent-memory/dist/mcp/server.js"],
      "env": {
        "AGENT_MEMORY_DB": "./agent-memory.db",
        "AGENT_MEMORY_AGENT_ID": "noah",
        "AGENT_MEMORY_AUTO_INGEST": "1",
        "AGENT_MEMORY_WORKSPACE": "/home/user/.openclaw/workspace"
      }
    }
  }
}
```

### MCP 工具（9个）

- `remember`
- `recall`
- `recall_path`
- `boot`
- `forget`
- `reflect`
- `status`
- `ingest`
- `surface`

> v3 已移除 `link` / `snapshot` 工具。

---

## Auto-Ingest（文件变更自动入库）

MCP server 启动后会默认开启 watcher（`fs.watch`）：

- `~/.openclaw/workspace/memory/*.md`
- `~/.openclaw/workspace/MEMORY.md`

当文件变化时自动执行 ingest（复用 Write Guard，幂等/去重）。

环境变量：

- `AGENT_MEMORY_AUTO_INGEST`
  - `1`（默认）：开启
  - `0`：关闭
- `AGENT_MEMORY_WORKSPACE`
  - 默认：`$HOME/.openclaw/workspace`

---

## OpenClaw 集成建议（方案A）

推荐三段 cron：

1. `memory-sync`（14:00 / 22:00）
   - 动态发现 session JSONL
   - 增量写入 `memory/YYYY-MM-DD.md`
   - best-effort 同步到 `agent-memory.remember`
   - 输出健康指标（扫描路径、会话文件数、提取数、写库数）

2. `memory-tidy`（03:00）
   - 压缩/蒸馏 markdown
   - 调用 `agent-memory.reflect phase=all`

3. `memory-surface`（14:05 / 22:05）
   - 生成 `RECENT.md`

设计原则：**Markdown 是真相源，agent-memory 是派生索引层。**

---

## 开发

```bash
npm install
npm test
npm run build
```

---

## License

MIT
