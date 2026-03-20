# OpenClaw Integration Guide

OpenClaw is a **good host example**, not a requirement for AgentMemory.

If you are using OpenClaw, this guide shows how to integrate AgentMemory v5
without making OpenClaw-specific assumptions part of the product definition.

## When to use this guide

Use this guide only if your runtime already has:

- an OpenClaw workspace
- OpenClaw cron jobs or MCP integration
- an optional Markdown memory workflow such as `memory/*.md + MEMORY.md`

If you are not using OpenClaw, go to
[Generic runtime integration](generic.md) instead.

## Recommended role split

A clean OpenClaw setup usually looks like this:

- **Markdown files** remain the human-readable layer
- **AgentMemory** becomes the structured memory layer with retrieval and
  lifecycle management
- **OpenClaw cron / prompts** orchestrate when sync, tidy, and surface happen

That means the Markdown workflow is still valid here, but it is now an
**optional integration pattern**, not the definition of AgentMemory itself.

## MCP server configuration

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["./node_modules/@smyslenny/agent-memory/dist/mcp/server.js"],
      "env": {
        "AGENT_MEMORY_DB": "~/.openclaw/workspace/agent-memory.db",
        "AGENT_MEMORY_AGENT_ID": "my-agent",
        "AGENT_MEMORY_AUTO_INGEST": "1",
        "AGENT_MEMORY_WORKSPACE": "~/.openclaw/workspace"
      }
    }
  }
}
```

### Notes

- `AGENT_MEMORY_AUTO_INGEST=1` makes sense here because OpenClaw often has a
  real workspace to watch
- `AGENT_MEMORY_WORKSPACE` should point at the actual OpenClaw workspace root
- if you do **not** want watcher-based ingest, set `AGENT_MEMORY_AUTO_INGEST=0`

## Suggested OpenClaw memory pipeline

A practical pattern is:

1. **memory-sync**
   - append new raw observations to `memory/YYYY-MM-DD.md`
   - optionally sync durable bullets into AgentMemory via `remember`
2. **memory-tidy**
   - compress and distill Markdown memory files
   - run `reflect all` so lifecycle maintenance stays active
3. **memory-surface**
   - optionally generate a short human-readable context file such as `RECENT.md`

This keeps responsibilities separated:

- Markdown is good for human editing and auditability
- AgentMemory is good for retrieval, dedup, surfacing, and lifecycle
- OpenClaw is good at orchestration and scheduled host behavior

## v5 Features for OpenClaw Users

AgentMemory v5 adds six intelligence features that are particularly useful
in the OpenClaw cron pipeline:

### Memory Provenance (F6)

When calling `remember` from your sync prompt, include provenance metadata:

```
remember(content="...", type="knowledge",
  source_session="session-id",
  source_context="extracted from 14:00 sync",
  observed_at="2026-03-20T14:00:00+08:00")
```

### Temporal Recall (F3)

Use `after`, `before`, and `recency_boost` to filter memories by time:

```
recall(query="deployment decisions", after="2026-03-01", recency_boost=true)
surface(task="plan next sprint", after="2026-03-15", related=true)
```

### Memory Links (F1)

The `link` tool allows manual association between memories. Use `related=true`
in `recall` or `surface` to expand results with linked memories.

### Conflict Detection (F2)

Write Guard detects contradictions during writes (e.g., status changes from
TODO to DONE). Conflicts are reported without blocking writes.

### Passive Feedback (F4) & Semantic Decay (F5)

`recall` automatically logs positive feedback for top hits. The `tidy` phase
detects stale content patterns and accelerates decay for outdated memories.

## Example directory layout

```text
~/.openclaw/workspace/
├── MEMORY.md
├── memory/
│   ├── 2026-03-09.md
│   ├── 2026-03-08.md
│   ├── weekly/
│   └── archive/
└── agent-memory.db
```

Again: this is a **host-specific workflow**, not a universal requirement.

## Recommended scheduled tasks

### memory-sync

Use it to:

- extract durable bullets from recent activity
- append them to daily Markdown memory
- optionally mirror them into AgentMemory with `remember`

### memory-tidy

Use it to:

- compress old notes
- update curated long-term memory files
- run `reflect all` so decay / governance keep moving

### memory-surface

Use it to:

- produce a small current-context file for runtime bootstrapping
- optionally combine surfaced memory with other host context

## Why OpenClaw is still valuable here

OpenClaw remains a good example because it already has:

- a workspace convention
- cron orchestration
- prompt-driven memory janitors
- an MCP-friendly runtime model

What changed in v4 is not support, but **positioning**:

- OpenClaw is no longer the default assumption in the README
- its integration details live here and in examples
- generic runtimes get equal first-class documentation

## Example files

See [examples/openclaw](../../examples/openclaw) for:

- setup notes and cron configuration
- memory janitor Phase 5 template
- journal and long-term memory examples

## Migration notes for v3 users

If you came from the old v3 README:

- the OpenClaw workflow is still supported
- it has simply moved out of the project homepage
- generic integration guidance now lives alongside it, not under it

For release-level changes, see [v3 → v4 migration guide](../migration-v3-v4.md)
and the [README](../../README.md) for v5 features.
