# 🧠 AgentMemory

> **Sleep-cycle memory architecture for AI agents** — journal, consolidate, recall.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)]()

---

## 💡 The Problem

AI agents forget everything between sessions. Context windows are finite. Conversation history gets truncated. Important decisions, lessons, and preferences vanish.

**AgentMemory** solves this by giving AI agents a persistent memory system inspired by how human brains consolidate memories during sleep.

## 🌙 How It Works — The Sleep Cycle

Just like humans consolidate memories during sleep, AgentMemory manages information across four phases:

| Phase | Human Analogy | What It Does |
|-------|--------------|-------------|
| 🌅 **Awake** | Jotting notes | Instant journaling — write events as they happen |
| 🌙 **Light Sleep** | Reviewing the day | Periodic sync — scan recent logs, extract highlights |
| 🌑 **Deep Sleep** | Memory consolidation | Compress old dailies → weekly summaries, distill → long-term memory |
| 🔍 **Recall** | Remembering | Semantic search across all memory layers |

## ✨ Features

- **📝 Instant Journaling** — `journal()`, `decision()`, `lesson()`, `preference()`
- **🌙 Light Sleep Sync** — Extract highlights from recent notes based on distill criteria
- **🌑 Deep Sleep Tidy** — Archive old dailies, create weekly summaries, distill to long-term memory
- **🔍 Multi-Layer Recall** — Search across daily notes, weekly summaries, and long-term memory
- **🗑️ Selective Forgetting** — Remove outdated memories by pattern
- **📊 Memory Stats** — Track usage, capacity, date ranges
- **⏰ Auto-Scheduling** — Start daemon-mode sleep cycles
- **📁 Markdown-Based** — All storage is plain Markdown files, human-readable
- **🚀 Zero Dependencies** — Pure Node.js, nothing to install
- **💻 CLI + Library** — Use from terminal or import in your agent code

---

## 🚀 Quick Start

### CLI

```bash
# Install globally
npm install -g agent-memory

# Run the demo
agent-memory demo

# Journal something
agent-memory journal "User prefers dark themes"
agent-memory decision "Switched from Starship to Oh My Posh"
agent-memory lesson "Cache miss with key rotation costs 12x more"

# Search your memory
agent-memory recall "dark theme"

# Run memory consolidation
agent-memory sync    # Light sleep
agent-memory tidy    # Deep sleep

# Check stats
agent-memory stats
```

### Library

```javascript
const { AgentMemory } = require('agent-memory');

const mem = new AgentMemory({ baseDir: '.my-agent-memory' });

// Awake — write as things happen
mem.journal('Set up project with Claude Opus 4.6');
mem.decision('Use Brave Search instead of Perplexity');
mem.lesson('Always use background mode for long exec commands');
mem.preference('User likes dark themes, hates blue-purple gradients');

// Light Sleep — extract highlights
const { highlights } = mem.sync();

// Deep Sleep — compress and distill
const { archived, distilled } = mem.tidy();

// Recall — search all layers
const results = mem.recall('dark theme preference');
// → [{ source: 'daily', score: 0.8, snippet: 'User likes dark themes...' }]

// Selective forgetting
mem.forget('outdated-project');

// Auto-scheduling (daemon mode)
mem.startCycles();  // Runs sync every 4h, tidy every 24h
```

---

## 📋 CLI Commands

| Command | Description |
|---------|-------------|
| `agent-memory journal <text>` | Write entry to today's daily note |
| `agent-memory decision <text>` | Record a key decision |
| `agent-memory lesson <text>` | Record a lesson learned |
| `agent-memory sync` | Light sleep — extract highlights from recent notes |
| `agent-memory tidy` | Deep sleep — archive old dailies, distill to long-term memory |
| `agent-memory recall <query>` | Search across all memory layers |
| `agent-memory forget <pattern>` | Remove matching entries from long-term memory |
| `agent-memory stats` | Show memory statistics |
| `agent-memory demo` | Run full demo with sample data |

### Options

| Flag | Description |
|------|-------------|
| `--dir <path>` | Memory directory (default: `.agent-memory`) |
| `--json` | Output as JSON |
| `--help` | Show help |
| `--version` | Show version |

---

## 🏗️ Memory Architecture

```
.agent-memory/
├── MEMORY.md          ← Long-term memory (distilled, 80-line cap)
├── daily/
│   ├── 2026-02-19.md  ← Today's raw notes
│   └── 2026-02-18.md  ← Yesterday's notes
├── weekly/
│   └── week-2026-02-10.md  ← Compressed weekly summary
└── archive/
    └── 2026-02-10.md  ← Old dailies (preserved)
```

### Memory Layers

| Layer | Retention | Purpose |
|-------|-----------|---------|
| **Daily** | 7 days (configurable) | Raw event log, full detail |
| **Weekly** | Indefinite | Compressed summaries of daily notes |
| **Long-term** | Indefinite (80-line cap) | Distilled decisions, lessons, preferences |
| **Archive** | Indefinite | Old dailies preserved for reference |

### Distill Criteria

Entries are promoted to long-term memory if they match:
- Category: `decision`, `lesson`, `preference`
- Keywords: `decision`, `lesson`, `preference`, `important`

Customize via config:
```javascript
new AgentMemory({
  distillCriteria: ['decision', 'lesson', 'preference', 'important', 'critical'],
  longTermMaxLines: 100,
  maxDailyAgeDays: 14,
});
```

---

## 🔌 Integration Examples

### With OpenClaw

```javascript
// In your agent's heartbeat handler
const { AgentMemory } = require('agent-memory');
const mem = new AgentMemory({ baseDir: '/home/user/.openclaw/workspace/memory' });

// During conversations
mem.journal(`User asked about ${topic}`);
mem.decision(`Chose ${model} for this task`);

// In heartbeat cron
const { highlights } = mem.sync();
if (highlights.length > 0) {
  // Report new highlights to user
}
```

### With LangChain

```javascript
const { AgentMemory } = require('agent-memory');
const mem = new AgentMemory();

// Before each LLM call, inject relevant memories
const context = mem.recall(userQuery);
const memoryContext = context.map(r => r.snippet).join('\n');
```

### With Cline CLI

```javascript
// Add persistent memory to Cline agents
const { AgentMemory } = require('agent-memory');
const mem = new AgentMemory({ baseDir: '.cline-memory' });

// After each task
mem.journal(`Completed: ${taskDescription}`);
mem.lesson(`${whatWorked} — remember for next time`);

// Before starting new task
const relevant = mem.recall(taskDescription);
```

---

## 🆚 Comparison

| Feature | AgentMemory | Mem0 | ALMA | memsearch |
|---------|:-----------:|:----:|:----:|:---------:|
| Zero dependencies | ✅ | ❌ | ❌ | ❌ |
| Sleep-cycle model | ✅ | ❌ | ❌ | ❌ |
| Automatic consolidation | ✅ | ❌ | ❌ | ❌ |
| Selective forgetting | ✅ | ✅ | ✅ | ❌ |
| Markdown storage | ✅ | ❌ | ❌ | ✅ |
| CLI tool | ✅ | ❌ | ❌ | ❌ |
| No API key needed | ✅ | ❌ | ❌ | ✅ |
| Human-readable files | ✅ | ❌ | ❌ | ✅ |

---

## 🤝 Contributing

1. **New memory strategies** — Improve consolidation algorithms
2. **Better recall** — Add embedding-based semantic search
3. **New integrations** — Plugins for popular agent frameworks
4. **Storage backends** — SQLite, Redis, S3

```bash
git clone https://github.com/smysle/agent-memory.git
cd agent-memory
node bin/agent-memory.js demo
```

---

## 📄 License

[MIT](LICENSE) © 2026
