# HTTP API Example

This example shows how to run AgentMemory as a long-lived local service.

## Start the server

```bash
npm install @smyslenny/agent-memory
export AGENT_MEMORY_DB=./agent-memory.db
export AGENT_MEMORY_AGENT_ID=http-demo

npx agent-memory serve --host 127.0.0.1 --port 3000
```

## Write a memory

```bash
curl -s -X POST http://127.0.0.1:3000/v1/memories \
  -H 'content-type: application/json' \
  --data @examples/http-api/remember.json
```

The `remember.json` payload includes v5 provenance fields (`source_session`,
`source_context`, `observed_at`) for tracking memory origin.

## Recall memories

```bash
curl -s -X POST http://127.0.0.1:3000/v1/recall \
  -H 'content-type: application/json' \
  --data @examples/http-api/recall.json
```

The `recall.json` payload demonstrates v5 temporal filtering (`after`, `before`,
`recency_boost`) and related-memory expansion (`related`).

## Surface context for a task

```bash
curl -s -X POST http://127.0.0.1:3000/v1/surface \
  -H 'content-type: application/json' \
  --data @examples/http-api/surface.json
```

The `surface.json` payload shows task-aware surfacing with v5 parameters
(`related`, `after`, `recency_boost`).

## Stream reflect progress

```bash
./examples/http-api/reflect-sse.sh
```

## Files

- `remember.json` — create / merge a knowledge memory (with v5 provenance)
- `recall.json` — explicit search with temporal filtering and related expansion
- `surface.json` — task-aware surface request with v5 parameters
- `reflect-sse.sh` — SSE example for lifecycle progress
