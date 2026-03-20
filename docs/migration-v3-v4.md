# Migration Guide: v3 → v4

This guide helps existing v3 users move to **`4.0.0-alpha.1`**.

## Summary

AgentMemory v4 keeps the core idea of structured agent memory, but changes the
product framing and expands the runtime surface:

- from **OpenClaw-first companion layer**
- to **general-purpose agent memory layer with lifecycle management**

The big practical changes are:

- optional **hybrid retrieval** with embeddings
- stronger **Write Guard** with semantic dedup and typed merge
- resumable **reflect** job orchestration
- new **HTTP/SSE API**
- improved **surface** with task-aware context scoring
- docs and examples reorganized around generic runtimes first

## What stays compatible

These remain valid in v4:

- SQLite-first deployment
- CLI usage
- MCP stdio usage
- existing core memory types (`identity`, `emotion`, `knowledge`, `event`)
- BM25-only operation when no embedding provider is configured
- OpenClaw integration as an optional host workflow

## What changed

### 1. Positioning changed

In v3, the docs framed AgentMemory primarily as an OpenClaw companion.
In v4, that is no longer the default assumption.

What this means:

- `memory/*.md + MEMORY.md` is still supported, but now documented as an
  **optional workflow**
- OpenClaw setup moved out of the homepage into dedicated docs/examples
- the main README is now written for any agent runtime

### 2. Retrieval is no longer BM25-only by design

v4 adds optional embedding-based retrieval.

If you do nothing, the system still works exactly in BM25-only mode.
If you enable embeddings, you also get:

- vector-assisted recall
- semantic dedup support in the write path
- reindex support for backfilling embeddings

### 3. New HTTP/SSE transport

v3 exposed CLI + MCP stdio. v4 adds a long-lived HTTP server.

New CLI entry point:

```bash
npx agent-memory serve --host 127.0.0.1 --port 3000
```

New HTTP routes include:

- `POST /v1/memories`
- `POST /v1/recall`
- `POST /v1/surface`
- `POST /v1/feedback`
- `POST /v1/reflect`
- `POST /v1/reindex`
- `GET /v1/status`
- `GET /v1/jobs/:id`

`reflect` and `reindex` support SSE streaming for progress updates.

### 4. MCP tool surface expanded

v3 documentation described 9 tools.

v4 tool list is:

- `remember`
- `recall`
- `recall_path`
- `boot`
- `forget`
- `reflect`
- `status`
- `ingest`
- `reindex`
- `surface`

If you maintain host-side docs or capability declarations, update them from
**9 tools** to **10 tools**.

### 5. Lifecycle reliability improved

`reflect` is now treated more like a tracked maintenance job than a blind
one-shot operation.

This helps with:

- observability
- job status inspection
- recovery after interrupted maintenance runs

### 6. Surface is more context-aware

v3 surface behavior was much simpler.

In v4, `surface` can use:

- `task`
- `query`
- `recent_turns`
- `intent`
- type filters
- feedback priors

This makes it more useful for proactive context injection before planning or
response generation.

## Upgrade checklist

### Minimal upgrade

If you want the simplest possible v4 upgrade:

1. install the new package version
2. run schema migration implicitly via startup or explicitly with `db:migrate`
3. keep using CLI / MCP as before
4. ignore embeddings and HTTP until you need them

Commands:

```bash
npm install @smyslenny/agent-memory@4.0.0-alpha.1
export AGENT_MEMORY_DB=./agent-memory.db
export AGENT_MEMORY_AGENT_ID=my-agent

npx agent-memory db:migrate
npx agent-memory status
```

### Enable embeddings later

If you want hybrid retrieval after upgrading:

```bash
export AGENT_MEMORY_EMBEDDING_PROVIDER=openai-compatible
export AGENT_MEMORY_EMBEDDING_BASE_URL=https://your-embedding-endpoint.example
export AGENT_MEMORY_EMBEDDING_MODEL=text-embedding-3-small
export AGENT_MEMORY_EMBEDDING_DIMENSION=1536
export AGENT_MEMORY_EMBEDDING_API_KEY=your-api-key

npx agent-memory reindex
```

No full external vector database is required.

### Adopt HTTP later

If you want to switch from per-call stdio to a long-lived service:

```bash
npx agent-memory serve --host 127.0.0.1 --port 3000
```

Then migrate your runtime calls from MCP/CLI to HTTP incrementally.

## Config changes to be aware of

### Generic runtimes

If you are not using a markdown workspace workflow, set:

```bash
export AGENT_MEMORY_AUTO_INGEST=0
```

This avoids watching an OpenClaw-style workspace path unnecessarily.

### OpenClaw users

If you do rely on watcher-based ingest, keep or add:

```bash
export AGENT_MEMORY_AUTO_INGEST=1
export AGENT_MEMORY_WORKSPACE=/path/to/.openclaw/workspace
```

## Documentation map after migration

Where things moved in v4:

- main overview → [README.md](../README.md)
- generic runtime integration → [integrations/generic.md](integrations/generic.md)
- OpenClaw integration → [integrations/openclaw.md](integrations/openclaw.md)
- architecture → [architecture.md](architecture.md)
- examples → [../examples](../examples)

## Suggested migration path by user type

### If you were a v3 CLI user

- keep your current flow
- optionally add `serve` later
- optionally enable embeddings + `reindex`

### If you were a v3 MCP user

- keep your MCP config
- update your tool list docs to include `reindex`
- disable auto-ingest unless you intentionally use workspace watching

### If you were a v3 OpenClaw user

- keep your current workflow if it works for you
- update links to the moved docs/examples
- treat Markdown as your host workflow, not as the entire definition of the
  package

## Breaking mindset change

The biggest v4 migration is conceptual, not operational:

> AgentMemory is now documented as a standalone memory layer that can live
> inside many runtimes, not just one host ecosystem.

That makes the project easier to evaluate, easier to adopt, and easier to plug
into systems that do not look like OpenClaw at all.

## What's next: v5

AgentMemory **v5 (Memory Intelligence)** is now available. It adds six
backward-compatible features on top of v4:

- **Memory Links** — automatic semantic associations between memories
- **Conflict Detection** — Write Guard detects contradictions during writes
- **Temporal Recall** — `after`, `before`, and `recency_boost` for time-aware search
- **Passive Feedback** — automatic positive feedback for accessed memories
- **Semantic Decay** — stale content detection beyond pure time-based Ebbinghaus
- **Memory Provenance** — `source_session`, `source_context`, `observed_at` metadata

All v4 workflows continue to work unchanged. See the
[README](../README.md) for the full v5 feature overview.
