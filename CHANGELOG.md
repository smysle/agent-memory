# Changelog

## 2.1.1 (2026-02-21)

### 📝 Documentation

- **Memory-janitor integration guide** — New `examples/openclaw-setup.md` section explaining what a memory janitor is and how to wire it to agent-memory (decay trigger + consistency check) ([PR #2](https://github.com/smysle/agent-memory/pull/2))
- **Phase 5 prompt template** — New `examples/memory-janitor-phase5.md` with full prompt template for appending decay + consistency phases to an existing janitor cron job
- Covers Gap 1 (Ebbinghaus decay never fires without external trigger) and Gap 2 (two-store divergence between agent-memory and canonical memory files)
- Includes configurable conflict resolution strategies (canonical wins / agent-memory wins / manual review)

## 2.0.0 (2026-02-20)

### 🎉 Complete Rewrite

AgentMemory v2 is a ground-up rewrite incorporating the best ideas from 4 open-source memory projects (nocturne_memory, Memory Palace, PowerMem, our v1) while keeping the codebase minimal (3 dependencies).

### ✨ New Features

- **URI Path System** — `core://`, `emotion://`, `knowledge://`, `event://` namespaces with Content-Path separation
- **Write Guard** — Hash dedup → URI conflict → BM25 similarity → 4-criterion gate pipeline
- **Ebbinghaus Forgetting Curve** — Scientific decay model `R = e^(-t/S)` with recall strengthening
- **Knowledge Graph** — Association links with multi-hop BFS traversal
- **Snapshot/Rollback** — Auto-snapshot before every modification, one-click restore
- **Intent-Aware Search** — Factual / temporal / causal / exploratory query classification
- **Sleep Cycle Engine** — Automated sync → decay → tidy → govern pipeline
- **Priority System** — P0 identity (never decays) through P3 event (14-day half-life)
- **Multi-Agent Isolation** — Per-agent memory scoping via `agent_id`
- **MCP Server** — 9 tools for Claude Code / Cursor / OpenClaw integration
- **CLI** — 7 commands: init, remember, recall, boot, status, reflect, migrate
- **Markdown Migration** — Import existing MEMORY.md + daily journals + weekly summaries

### 📊 Stats

- 14 source modules
- 9 MCP tools
- 7 CLI commands
- 41 tests passing
- 3 production dependencies

### 🙏 Inspired By

- [nocturne_memory](https://github.com/Dataojitori/nocturne_memory) — URI paths, Content-Path separation, boot loading
- [Memory Palace](https://github.com/AGI-is-going-to-arrive/Memory-Palace) — Write Guard, intent search, vitality decay
- [PowerMem](https://github.com/oceanbase/powermem) — Ebbinghaus curve, knowledge graph, multi-agent
- Our v1 production experience — Sleep cycle, dedup, 4-criterion gate, emotional priority
