# 🧠 AgentMemory

> **Sleep-cycle memory architecture for AI agents** — journal, consolidate, recall.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org/)

**English** | **[简体中文](README.zh-CN.md)**

---

## 💡 The Problem

AI agents forget everything between sessions. Context windows are finite. Conversation history gets truncated. Important decisions, lessons, and preferences vanish.

**AgentMemory** solves this by giving AI agents a persistent memory system inspired by how human brains consolidate memories during sleep.

## 🌙 How It Works — The Sleep Cycle

| Phase | Human Analogy | Agent Behavior | Schedule |
|-------|--------------|----------------|----------|
| **Awake** | Experience | Write important events to daily journal immediately | Real-time |
| **Light Sleep** | Memory replay | `memory-sync`: scan sessions, extract highlights, **deduplicate**, fill gaps | 2x/day (14:00 & 22:00) |
| **Deep Sleep** | Memory consolidation | `memory-tidy`: compress old journals → weekly, distill → MEMORY.md, archive | 1x/day (03:00) |
| **Recall** | Memory retrieval | Semantic search via `memory_search` → `memory_get` | On demand |

```
         ┌─────────────┐
         │   Awake     │  Real-time journaling
         │  (Journal)  │  memory/YYYY-MM-DD.md
         └──────┬──────┘
                │
         ┌──────▼──────┐
         │ Light Sleep │  14:00 & 22:00
         │(memory-sync)│  Deduplicate + extract highlights
         └──────┬──────┘
                │
         ┌──────▼──────┐
         │ Deep Sleep  │  03:00
         │(memory-tidy)│  Compress → weekly, distill → MEMORY.md
         └──────┬──────┘
                │
         ┌──────▼──────┐
         │   Recall    │  On demand
         │  (Search)   │  Semantic search across all memory
         └─────────────┘
```

## 📁 Memory Architecture

```
workspace/
├── MEMORY.md                    # 🧠 Long-term memory (≤200 lines, curated)
├── memory/
│   ├── 2026-02-20.md           # 📝 Today's journal (raw, real-time)
│   ├── 2026-02-19.md           # 📝 Yesterday
│   ├── ...                     # Recent 7 days
│   ├── weekly/
│   │   └── 2026-02-09.md      # 📦 Compressed weekly summaries
│   ├── archive/
│   │   ├── 2026-02-12.md      # 🗄️ Archived dailies
│   │   └── MEMORY.md.bak-*    # 💾 MEMORY.md backups
│   └── heartbeat-state.json    # 💓 Heartbeat timestamps
```

### Three-Tier Memory

| Tier | File | Retention | Content |
|------|------|-----------|---------|
| **Hot** | `memory/YYYY-MM-DD.md` | 7 days | Raw daily notes, everything that happened |
| **Warm** | `memory/weekly/*.md` | Indefinite | Compressed weekly summaries with source annotations |
| **Cold** | `MEMORY.md` | Permanent | Curated long-term memory, ≤200 lines, 4-criterion gate |

## 🔑 Key Design Decisions

### 1. Deduplication is Everything

The #1 lesson from production: **memory-sync MUST check existing content before writing**. Without dedup, the same events get written 7-8 times (once per sync run). Our sync prompt now requires:

1. Read the existing journal first
2. Compare line-by-line with new conversation data
3. Only append truly new events
4. Never rewrite existing sections

### 2. The 4-Criterion Gate (MEMORY.md)

Before anything enters long-term memory, ALL four must be true:

- **(a)** Not having this would cause a specific mistake
- **(b)** Applies to multiple future conversations
- **(c)** Self-contained and understandable without context
- **(d)** Not redundant with existing MEMORY.md content

**Reverse check**: "What specific mistake would I make without this?" — if you can't answer, don't write it.

### 3. Emotional > Technical

Priority order for memory capture:
1. 💬 What the user said / emotional interactions (HIGHEST)
2. 🎯 Key decisions and conclusions
3. ✅ Completed milestones
4. 📚 Lessons learned / pitfalls
5. 🔧 Technical operations (LOWEST — one-liner is fine)

### 4. 80-Line Hard Limit

MEMORY.md has a hard cap of 200 lines. This forces curation — when you hit the limit, you must compress or remove outdated entries before adding new ones. This prevents unbounded growth and keeps recall fast.

## 🚀 Quick Start

### Option A: Use with OpenClaw (Recommended)

See [`examples/openclaw-setup.md`](examples/openclaw-setup.md) for the complete setup guide including:
- Cron job configuration
- qmd semantic search integration
- Proven prompt templates

### Option B: Use the CLI

```bash
# Install
npm install -g agent-memory

# Initialize memory structure
agent-memory init

# Write to today's journal
agent-memory journal "Deployed v2.0 to production"

# Semantic search across all memory
agent-memory recall "deployment issues"

# Run memory consolidation
agent-memory sync   # Light sleep — deduplicate & extract
agent-memory tidy   # Deep sleep — compress & distill
```

### Option C: Use as a Library

```javascript
import { AgentMemory } from 'agent-memory';

const memory = new AgentMemory({ workDir: './workspace' });

// Journal (awake phase)
await memory.journal('User prefers dark mode');

// Recall (search phase)
const results = await memory.recall('user preferences');

// Sync (light sleep)
await memory.sync();

// Tidy (deep sleep)
await memory.tidy();
```

## 📋 Example Files

| File | Description |
|------|-------------|
| [`examples/openclaw-setup.md`](examples/openclaw-setup.md) | Full OpenClaw integration guide |
| [`examples/memory-sync-prompt.txt`](examples/memory-sync-prompt.txt) | Production memory-sync cron prompt |
| [`examples/memory-tidy-prompt.txt`](examples/memory-tidy-prompt.txt) | Production memory-tidy cron prompt |
| [`examples/MEMORY.md.example`](examples/MEMORY.md.example) | Example long-term memory file |
| [`examples/daily-journal.md.example`](examples/daily-journal.md.example) | Example daily journal |

## 🧪 Production Stats

Running since 2026-02-12:
- **119 documents** indexed (daily logs + sessions + MEMORY.md)
- **93% search accuracy** with qmd (BM25 + vector + reranking)
- **~2s recall** with qmd daemon, ~60s without (CPU-only)
- **8 daily journals** compressed into weekly summaries
- **78/200 lines** in MEMORY.md (well within limit)

## 🤝 Works With

- **[OpenClaw](https://github.com/openclaw/openclaw)** — Full integration via cron jobs + qmd backend
- **Any LLM agent** — The prompts and architecture are model-agnostic
- **Any cron system** — Just schedule the sync/tidy prompts however you like

## 📄 License

MIT — use it, fork it, make your agents remember.

---

*Built with 🧠 by agents who got tired of forgetting.*
