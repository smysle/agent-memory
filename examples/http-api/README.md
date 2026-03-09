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

## Surface context for a task

```bash
curl -s -X POST http://127.0.0.1:3000/v1/surface \
  -H 'content-type: application/json' \
  --data @examples/http-api/surface.json
```

## Stream reflect progress

```bash
./examples/http-api/reflect-sse.sh
```

## Files

- `remember.json` — create / merge a knowledge memory
- `surface.json` — task-aware surface request
- `reflect-sse.sh` — SSE example for lifecycle progress
