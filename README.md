# 🧠 AgentMemory v2

> **Sleep-cycle memory architecture for AI agents** — remember, recall, forget, evolve.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/protocol-MCP-orange.svg)](https://modelcontextprotocol.io/)

**English** | **[简体中文](README.zh-CN.md)**

---

## 💡 The Problem

AI agents forget everything between sessions. Context windows are finite. Conversation history gets truncated. Important decisions, lessons, and preferences vanish.

## 🌙 The Solution: Sleep-Cycle Memory

Inspired by how human brains consolidate memories during sleep, AgentMemory manages information across four phases:

```
  Awake          Light Sleep       Deep Sleep        Recall
  (Journal)      (Sync)            (Tidy)           (Search)
  ────────── ──→ ────────── ──→ ────────── ──→ ──────────
  Real-time      Deduplicate      Compress          Intent-aware
  capture        + extract        + distill         BM25 search
                                  + decay           + priority
```

## ✨ Key Features

| Feature | Description | Inspired By |
|---------|-------------|-------------|
| 🔗 **URI Path System** | `core://user/name`, `emotion://2026-02-20/love` — structured, multi-entry access | nocturne_memory |
| 🛡️ **Write Guard** | Hash dedup → URI conflict → BM25 similarity → 4-criterion gate | Memory Palace + our v1 |
| 🧠 **Ebbinghaus Decay** | `R = e^(-t/S)` — scientific forgetting curve with recall strengthening | PowerMem |
| 🕸️ **Knowledge Graph** | Multi-hop traversal across memory associations | PowerMem |
| 📸 **Snapshots** | Auto-snapshot before every change, one-click rollback | nocturne + Memory Palace |
| 🔍 **Intent-Aware Search** | Factual / temporal / causal / exploratory query routing | Memory Palace |
| 🌙 **Sleep Cycle** | Automated sync → decay → tidy → govern pipeline | **Our original design** |
| 💚 **Priority System** | P0 identity (never decays) → P3 event (14-day half-life) | **Our original design** |
| 🤝 **Multi-Agent** | Agent isolation via `agent_id` scope | PowerMem |
| 🔌 **MCP Server** | 9 tools, works with Claude Code / Cursor / OpenClaw | Standard MCP |

## 🚀 Quick Start

### Install

```bash
npm install agent-memory
```

### CLI

```bash
# Initialize database
agent-memory init

# Store memories
agent-memory remember "User prefers dark mode" --type knowledge --uri knowledge://user/preferences
agent-memory remember "I am Noah, a succubus" --type identity --uri core://agent/identity

# Search
agent-memory recall "user preferences"

# Load identity at startup
agent-memory boot

# Run sleep cycle
agent-memory reflect all

# Import from Markdown
agent-memory migrate ./memory/

# Statistics
agent-memory status
```

### Library

```typescript
import { openDatabase, syncOne, searchBM25, boot, runDecay } from 'agent-memory';

const db = openDatabase({ path: './memory.db' });

// Remember
syncOne(db, {
  content: 'User said "I love you"',
  type: 'emotion',
  uri: 'emotion://2026-02-20/love',
  emotion_val: 1.0,
});

// Recall
const results = searchBM25(db, 'love');

// Boot identity
const identity = boot(db);

// Sleep cycle
runDecay(db);
```

### MCP Server

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["node_modules/agent-memory/dist/mcp/server.js"],
      "env": {
        "AGENT_MEMORY_DB": "./memory.db"
      }
    }
  }
}
```

**9 MCP Tools:** `remember` · `recall` · `recall_path` · `boot` · `forget` · `link` · `snapshot` · `reflect` · `status`

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│         MCP Server (stdio/SSE)          │
│     9 tools + system://boot loader      │
├─────────────────────────────────────────┤
│              Write Guard                │
│  hash dedup → URI conflict → BM25 sim  │
│  → conflict merge → 4-criterion gate    │
├─────────────────────────────────────────┤
│           Sleep Cycle Engine            │
│  sync (capture) → decay (Ebbinghaus)   │
│  → tidy (archive) → govern (cleanup)   │
├─────────────────────────────────────────┤
│        Intent-Aware Search (BM25)       │
│  factual · temporal · causal · explore  │
├─────────────────────────────────────────┤
│     SQLite (WAL) + FTS5 + Graph Links   │
│  memories · paths · links · snapshots   │
└─────────────────────────────────────────┘
```

## 📊 Priority & Decay

| Priority | Domain | Half-life | Min Vitality | Example |
|----------|--------|-----------|-------------|---------|
| P0 Identity | `core://` | ∞ (never) | 1.0 | "I am Noah" |
| P1 Emotion | `emotion://` | 365 days | 0.3 | "User said I love you" |
| P2 Knowledge | `knowledge://` | 90 days | 0.1 | "Use TypeScript for agents" |
| P3 Event | `event://` | 14 days | 0.0 | "Configured proxy today" |

**Recall strengthens memory:** each search hit increases stability (S × 1.5), slowing future decay.

## 🔬 Design Decisions

1. **SQLite over Postgres/MongoDB** — Zero config, single file, WAL mode for concurrent reads
2. **BM25 over vector search** — No embedding dependency, instant startup, good enough for structured memory
3. **TypeScript over Python** — Better concurrency, type safety, OpenClaw ecosystem alignment
4. **Ebbinghaus over linear decay** — Scientifically grounded, recall strengthening is natural
5. **Write Guard over free writes** — Prevent duplicate/conflicting memories at the gate
6. **URI paths over flat keys** — Hierarchical organization, prefix queries, multi-entry access

## 📋 Project Documents

| Document | Description |
|----------|-------------|
| [PLANNING.md](PLANNING.md) | Technical architecture + 5-project comparison |
| [ROADMAP.md](ROADMAP.md) | Implementation phases + milestones |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 40+ acceptance criteria + performance targets |
| [COMPLETION.md](COMPLETION.md) | Release checklist + retrospective template |

## 📄 License

MIT

---

*Built by agents who got tired of forgetting. 🧠*
