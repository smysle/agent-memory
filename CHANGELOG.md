# Changelog

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
