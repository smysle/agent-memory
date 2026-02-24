# 🧠 AgentMemory v3

> Structured long-term memory layer for AI agents: write, recall, decay, and auto-ingest.

[![npm](https://img.shields.io/npm/v/@smyslenny/agent-memory)](https://www.npmjs.com/package/@smyslenny/agent-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-9_tools-orange.svg)](https://modelcontextprotocol.io/)

**[简体中文](README.md)** | **English**

---

## Positioning in v3

AgentMemory v3 is explicitly a **structured memory companion** to OpenClaw memory-core, not a second full-stack retrieval system.

- Markdown (`memory/*.md` + `MEMORY.md`) remains the human-readable source of truth
- agent-memory is a derived, structured lifecycle layer

Core capabilities:

- **Typed memory model**: `identity / emotion / knowledge / event`
- **URI path addressing**: `core://`, `emotion://`, `knowledge://`, `event://`
- **Write Guard** for dedup/conflict gating
- **BM25 recall** with priority × vitality weighting
- **Sleep-cycle maintenance** via `reflect` (decay / tidy / govern)
- **Ingest** for markdown-to-memory extraction
- **Surface** for readonly context surfacing (no access side effects)
- **Warm boot / reflect narrative output**
- **Multi-agent isolation** by `agent_id`

---

## Quick Start

### Install

```bash
npm install -g @smyslenny/agent-memory
```

### CLI examples

```bash
# Initialize DB
agent-memory init

# Store memory
agent-memory remember "User prefers dark mode" --type knowledge --uri knowledge://preferences/theme

# Search
agent-memory recall "user preferences" --limit 5

# Startup boot (narrative output)
agent-memory boot

# Run sleep cycle
agent-memory reflect all
```

---

## MCP Server

### Example config

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

### MCP tools (9)

- `remember`
- `recall`
- `recall_path`
- `boot`
- `forget`
- `reflect`
- `status`
- `ingest`
- `surface`

> `link` and `snapshot` were removed in v3.

---

## Auto-Ingest (file change watcher)

When MCP server starts, watcher is enabled by default (`fs.watch`) for:

- `~/.openclaw/workspace/memory/*.md`
- `~/.openclaw/workspace/MEMORY.md`

On file changes, ingest runs automatically (still guarded by Write Guard and dedup).

Environment variables:

- `AGENT_MEMORY_AUTO_INGEST`
  - `1` (default): enabled
  - `0`: disabled
- `AGENT_MEMORY_WORKSPACE`
  - default: `$HOME/.openclaw/workspace`

---

## Recommended OpenClaw integration

Use a 3-stage cron pipeline:

1. `memory-sync` (14:00 / 22:00)
   - dynamic session JSONL discovery
   - append incremental entries to `memory/YYYY-MM-DD.md`
   - best-effort `agent-memory.remember`
   - emit health metrics (scan path / file count / extracted / synced)

2. `memory-tidy` (03:00)
   - markdown consolidation/distillation
   - call `agent-memory.reflect phase=all`

3. `memory-surface` (14:05 / 22:05)
   - generate `RECENT.md`

Design principle: **Markdown is source of truth; agent-memory is a derived index layer.**

---

## Development

```bash
npm install
npm test
npm run build
```

---

## License

MIT
