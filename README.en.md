# 🧠 AgentMemory

> **Sleep-cycle memory architecture for AI agents** — remember, recall, forget, evolve.

[![npm](https://img.shields.io/npm/v/@smyslenny/agent-memory)](https://www.npmjs.com/package/@smyslenny/agent-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-9_tools-orange.svg)](https://modelcontextprotocol.io/)
[![Tests](https://img.shields.io/badge/tests-69_passed-brightgreen.svg)](#)

**[简体中文](README.md)** | **English**

---

## Why AgentMemory?

AI agents forget everything between sessions. Context windows are finite, conversation history gets truncated, and important decisions, lessons, and preferences vanish.

AgentMemory mimics the human sleep-cycle memory consolidation process, giving agents **persistent, decaying, searchable** long-term memory.

```
Awake (capture) → Light sleep (deduplicate) → Deep sleep (compress + decay) → Recall (hybrid search)
```

## Key Features

- **URI Path System** — `core://`, `emotion://`, `knowledge://`, `event://` namespaces for structured access
- **Write Guard** — Hash dedup → URI conflict → BM25 similarity → 4-criterion gate rejects junk memories
- **Ebbinghaus Decay** — `R = e^(-t/S)` scientific forgetting curve with recall strengthening
- **Hybrid Search** — BM25 full-text + vector semantic search + RRF fusion
- **Multi-Provider Embeddings** — OpenAI / Qwen / Gemini / DashScope with auto instruction-aware queries
- **External Reranker** — `/v1/rerank` API compatible (e.g. Qwen3-Reranker-8B), best-effort fallback
- **Knowledge Graph** — Association links between memories with multi-hop traversal
- **Snapshot Rollback** — Auto-snapshot before every write, one-click restore
- **Sleep Cycle Engine** — sync → decay → tidy → govern automated maintenance
- **Priority System** — P0 identity (never decays) through P3 event (14-day half-life)
- **Multi-Agent Isolation** — Multiple agents share one database without interference
- **MCP Server** — 9 tools for Claude Code / Cursor / OpenClaw
- **jieba Chinese Tokenizer** — CJK-friendly BM25 out of the box

## Quick Start

### Install

```bash
npm install -g @smyslenny/agent-memory
```

### 30-Second Demo

```bash
# Initialize database
agent-memory init

# Store a memory
agent-memory remember "User prefers dark mode" --type knowledge --uri knowledge://preferences/theme

# Search
agent-memory recall "user preferences"

# Load identity memories at startup
agent-memory boot

# Run sleep cycle (decay + cleanup)
agent-memory reflect all
```

### As a Library

```typescript
import { openDatabase, syncOne, searchBM25, boot, runDecay } from '@smyslenny/agent-memory';

const db = openDatabase({ path: './memory.db' });

// Write
syncOne(db, {
  content: 'User said "I love you"',
  type: 'emotion',
  uri: 'emotion://2026-02-20/love',
  emotion_val: 1.0,
});

// Search
const results = searchBM25(db, 'love');

// Load identity
const identity = boot(db);

// Decay
runDecay(db);
```

### MCP Server

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

**9 MCP Tools:** `remember` · `recall` · `recall_path` · `boot` · `forget` · `link` · `snapshot` · `reflect` · `status`

## Hybrid Search Pipeline

v2.2.0 introduces a full multi-layer retrieval pipeline:

```
Query → BM25 full-text search (jieba tokenizer)
      → Vector semantic search (multi-provider embeddings)
      → RRF fusion ranking
      → External reranker (optional)
      → Results
```

### Embedding Providers

Configure via environment variables:

| Provider | Env Variable | Default Model |
|----------|-------------|---------------|
| OpenAI-compatible | `AGENT_MEMORY_EMBEDDINGS_PROVIDER=openai` | text-embedding-3-small |
| Gemini | `AGENT_MEMORY_EMBEDDINGS_PROVIDER=gemini` | gemini-embedding-001 |
| DashScope/Qwen | `AGENT_MEMORY_EMBEDDINGS_PROVIDER=qwen` | text-embedding-v3 |

```bash
# Example: Qwen3-Embedding-8B via OpenAI-compatible API
export AGENT_MEMORY_EMBEDDINGS_PROVIDER=openai
export AGENT_MEMORY_EMBEDDINGS_MODEL=Qwen/Qwen3-Embedding-8B
export OPENAI_BASE_URL=https://your-api.com/v1
export OPENAI_API_KEY=sk-xxx
```

**Instruction-Aware Queries:** The system auto-detects model family — Qwen models get an instruction prefix for better retrieval (Hit@1: 66.7% → 91.7%), while Gemini models use plain mode (already optimal).

### Reranker

```bash
export AGENT_MEMORY_RERANK_PROVIDER=openai
export AGENT_MEMORY_RERANK_MODEL=Qwen/Qwen3-Reranker-8B
export AGENT_MEMORY_RERANK_BASE_URL=https://your-api.com/v1
export AGENT_MEMORY_RERANK_API_KEY=sk-xxx
```

Best-effort strategy: falls back to local scoring if the API is unavailable.

## Priority & Decay

| Priority | Namespace | Half-life | Min Vitality | Example |
|----------|-----------|-----------|-------------|---------|
| P0 Identity | `core://` | ∞ never | 1.0 | "I am Noah" |
| P1 Emotion | `emotion://` | 365 days | 0.3 | "User said I love you" |
| P2 Knowledge | `knowledge://` | 90 days | 0.1 | "Use TypeScript for agents" |
| P3 Event | `event://` | 14 days | 0.0 | "Configured proxy today" |

Each search hit increases stability (S × 1.5), slowing future decay. **The more a memory is recalled, the harder it is to forget** — just like humans.

## Architecture

```
┌──────────────────────────────────────────────┐
│            MCP Server (stdio/SSE)            │
│           9 tools + boot loader              │
├──────────────────────────────────────────────┤
│               Write Guard                    │
│   hash dedup → URI conflict → BM25 sim       │
│   → conflict merge → 4-criterion gate        │
├──────────────────────────────────────────────┤
│            Sleep Cycle Engine                │
│   sync → decay (Ebbinghaus) → tidy → govern  │
├──────────────────────────────────────────────┤
│     Hybrid Search (BM25 + Vector + RRF)      │
│   + External Reranker (optional)             │
│   + Instruction-Aware query adaptation       │
├──────────────────────────────────────────────┤
│      SQLite (WAL) + FTS5 + Knowledge Graph   │
│   memories · paths · links · embeddings      │
│   · snapshots                                │
└──────────────────────────────────────────────┘
```

## OpenClaw Integration

AgentMemory integrates with [OpenClaw](https://github.com/openclaw/openclaw)'s built-in memory cron jobs for a **Capture → Consolidate → Surface** closed loop:

| Phase | Cron Job | Schedule | What Happens |
|-------|----------|----------|-------------|
| Capture | `memory-sync` | 14:00 & 22:00 | Scan sessions → write journal → sync to agent-memory |
| Consolidate | `memory-tidy` | 03:00 | Compress old dailies → distill long-term memory → reflect |
| Surface | `memory-surface` | 14:05 & 22:05 | Recall high-vitality memories → generate RECENT.md |

**Design principle:** Markdown is the source of truth; agent-memory is a derived index layer. Sync failures never affect Markdown operations.

See [`docs/design/0004-agent-memory-integration.md`](docs/design/0004-agent-memory-integration.md) for details.

## Design Decisions

| Choice | Rationale |
|--------|-----------|
| SQLite over Postgres | Zero config, single file, WAL concurrency, deploy anywhere |
| BM25 + Vector hybrid | Exact keyword matching + semantic fuzzy matching, complementary |
| TypeScript over Python | Type safety, OpenClaw/MCP ecosystem alignment |
| Ebbinghaus over linear | Scientific basis, natural recall strengthening |
| Write Guard gating | Block junk at entry — cheaper than cleanup |
| URI paths | Hierarchical organization + prefix queries + multi-entry access |

## Stats

- **25 source modules** · **9 MCP tools** · **7 CLI commands** · **69 tests** · **3 runtime dependencies**

## Credits

Inspired by:
- [nocturne_memory](https://github.com/Dataojitori/nocturne_memory) — URI paths, Content-Path separation
- [Memory Palace](https://github.com/AGI-is-going-to-arrive/Memory-Palace) — Write Guard, intent search
- [PowerMem](https://github.com/oceanbase/powermem) — Ebbinghaus curve, knowledge graph, multi-agent

## License

MIT

---

*Built by agents who got tired of forgetting. 🧠*
