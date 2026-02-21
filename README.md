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
| 🌙 **Sleep Cycle** | Automated sync → decay → tidy → govern pipeline | - |
| 💚 **Priority System** | P0 identity (never decays) → P3 event (14-day half-life) | - |
| 🤝 **Multi-Agent** | Agent isolation via `agent_id` scope | PowerMem |
| 🔌 **MCP Server** | 9 tools, works with Claude Code / Cursor / OpenClaw | Standard MCP |

## 🚀 Quick Start

### Install

```bash
npm install @smyslenny/agent-memory
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
import { openDatabase, syncOne, searchBM25, boot, runDecay } from '@smyslenny/agent-memory';

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
    "@smyslenny/agent-memory": {
      "command": "node",
      "args": ["node_modules/@smyslenny/agent-memory/dist/mcp/server.js"],
      "env": {
        "AGENT_MEMORY_DB": "./memory.db"
      }
    }
  }
}
```

**9 MCP Tools:** `remember` · `recall` · `recall_path` · `boot` · `forget` · `link` · `snapshot` · `reflect` · `status`

## 🔗 OpenClaw Integration

AgentMemory works **out of the box** with [OpenClaw](https://github.com/smysle/openclaw)'s built-in memory cron jobs — no code changes required. The integration implements a **Capture → Consolidate → Surface** closed loop that keeps Markdown journals and the structured memory DB in sync automatically.

### How It Works

```
  Capture (memory-sync)          Consolidate (memory-tidy)        Surface (memory-surface)
  ─────────────────────          ─────────────────────────        ───────────────────────
  14:00 & 22:00                  03:00                            14:05 & 22:05
  Session → daily journal        Compress old dailies             Recall top memories
  + remember each bullet         Distill → MEMORY.md             → generate RECENT.md
    into agent-memory DB         + reflect phase=all              (≤80 lines, 3 sections)
```

| Phase | Cron Job | What Happens | agent-memory Integration |
|-------|----------|-------------|--------------------------|
| **Capture** | `memory-sync` | Scans sessions, appends bullets to `memory/YYYY-MM-DD.md` | Each new bullet is also written via `mcporter call agent-memory.remember` with auto-classified type and URI-based dedup |
| **Consolidate** | `memory-tidy` | Compresses old dailies → weekly summaries, distills `MEMORY.md` | Triggers `agent-memory.reflect phase=all` (decay + tidy + govern) + consistency spot-check |
| **Surface** | `memory-surface` | Generates short-term context for new sessions | Reads high-vitality memories from agent-memory, outputs structured `RECENT.md` with emotion/knowledge/event sections |

### Key Design Principles

- **Markdown is source of truth** — agent-memory is a derived index layer; all data flows Markdown → DB, never the reverse.
- **Best-effort sync** — If `mcporter` or agent-memory is unavailable, Markdown operations proceed normally. Failures only log warnings.
- **URI-based idempotency** — Each journal bullet maps to a unique URI (`event://journal/2026-02-21#2200-1`), so re-runs are safe.
- **Keyword-based classification** — Bullets are auto-classified as `knowledge`, `emotion`, or `event` using simple keyword rules (no extra model calls).

### Setup

If you're running OpenClaw with the standard memory cron suite (`memory-sync`, `memory-tidy`, `memory-surface`), the integration is **already active** — the cron prompts include agent-memory sync steps. Just make sure:

1. **agent-memory is installed and initialized** — `agent-memory init`
2. **mcporter bridge is configured** — agent-memory MCP server registered in your mcporter config
3. **Cron jobs are enabled** — check with `openclaw cron list`

For detailed setup and prompt templates, see:
- [`examples/openclaw-setup.md`](examples/openclaw-setup.md) — Full setup walkthrough
- [`docs/design/0004-agent-memory-integration.md`](docs/design/0004-agent-memory-integration.md) — Design document (DD-0004)

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
