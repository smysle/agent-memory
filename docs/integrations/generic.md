# Generic Agent Runtime Integration

This guide shows how to wire AgentMemory into a runtime **without assuming
OpenClaw** or any other specific host.

## Choose a transport

| Transport | Pick this when | Trade-off |
| --- | --- | --- |
| CLI | you already have shell jobs, cron, or local scripts | easiest to start, less ergonomic for per-turn calls |
| MCP stdio | your host already supports MCP tools | simple tool model, but stdio means process startup overhead |
| HTTP/SSE | you want a long-lived service or a non-Node runtime | best for multi-language services, needs a background server |

All three transports use the same application core.

## Shared environment variables

Minimum:

```bash
export AGENT_MEMORY_DB=./agent-memory.db
export AGENT_MEMORY_AGENT_ID=my-agent
```

Optional embedding provider for hybrid recall / semantic dedup:

```bash
export AGENT_MEMORY_EMBEDDING_PROVIDER=openai-compatible
export AGENT_MEMORY_EMBEDDING_BASE_URL=https://your-embedding-endpoint.example
export AGENT_MEMORY_EMBEDDING_MODEL=text-embedding-3-small
export AGENT_MEMORY_EMBEDDING_DIMENSION=1536
export AGENT_MEMORY_EMBEDDING_API_KEY=your-api-key
```

Or use:

```bash
export AGENT_MEMORY_EMBEDDING_PROVIDER=local-http
```

If no embedding provider is configured, AgentMemory runs in **BM25-only mode**.

## Integration pattern

A healthy runtime usually does all of the following:

### 1. Startup

Call `boot` once when the agent or worker starts.

Use it for:

- identity / role reminders
- stable preferences or operating rules
- boot-pinned URIs

### 2. Write path

Call `remember` when the runtime sees a **durable** memory candidate, such as:

- a user preference
- a persistent project decision
- an important event
- a stable instruction or identity fact

Avoid calling `remember` for every token or every low-value turn.

### 3. Read path

Use **`recall`** when the runtime has an explicit memory question.

Examples:

- "what did the user prefer last time?"
- "what was the deployment decision?"
- "what was promised for Friday?"

Use **`surface`** before a plan or reply when the runtime wants relevant context
without a direct lookup question.

Examples:

- drafting a weekly update
- planning a feature implementation
- answering a question where past preferences matter

### 4. Lifecycle path

Run `reflect all` on a schedule.

Typical cadence:

- low-volume agents: daily
- higher-volume agents: 2-4 times per day
- explicit operator action after big task batches

Run `reindex` when:

- you enable embeddings for the first time
- you change embedding provider or model
- you want to force a retrieval rebuild

### 5. Feedback loop

If your runtime can observe whether a surfaced or recalled memory helped,
record feedback.

This is especially useful when `surface` is part of an autonomous planning loop.

## CLI integration

CLI is the easiest path for prototypes, cron jobs, and shell-based runtimes.

```bash
npm install @smyslenny/agent-memory

export AGENT_MEMORY_DB=./agent-memory.db
export AGENT_MEMORY_AGENT_ID=my-agent

npx agent-memory init
npx agent-memory remember \
  "The user prefers concise release notes." \
  --type knowledge \
  --uri knowledge://users/default/preferences/release-notes

npx agent-memory recall "release notes preference" --limit 5
npx agent-memory reflect all
```

You can also run the HTTP server from the CLI:

```bash
npx agent-memory serve --host 127.0.0.1 --port 3000
```

## MCP stdio integration

MCP is a good fit when your host already has a tool abstraction.

### Example server config

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["./node_modules/@smyslenny/agent-memory/dist/mcp/server.js"],
      "env": {
        "AGENT_MEMORY_DB": "./agent-memory.db",
        "AGENT_MEMORY_AGENT_ID": "my-agent",
        "AGENT_MEMORY_AUTO_INGEST": "0"
      }
    }
  }
}
```

### MCP tool list

- `remember` — store a memory (supports provenance: `source_session`, `source_context`, `observed_at`)
- `recall` — hybrid search (supports `related`, `after`, `before`, `recency_boost`)
- `recall_path`
- `boot`
- `forget`
- `reflect`
- `status`
- `ingest`
- `reindex`
- `surface` — context-aware surfacing (supports `related`, `after`, `before`, `recency_boost`)
- `link` — manually create or remove associations between memories

See [examples/mcp-stdio](../../examples/mcp-stdio) for a minimal example.

## HTTP API integration

HTTP/SSE is the best fit for long-lived runtimes, workers, and non-Node hosts.

### Start the server

```bash
npm install @smyslenny/agent-memory
export AGENT_MEMORY_DB=./agent-memory.db
export AGENT_MEMORY_AGENT_ID=my-agent

npx agent-memory serve --host 127.0.0.1 --port 3000
```

### Minimal write / read flow

```bash
curl -s -X POST http://127.0.0.1:3000/v1/memories \
  -H 'content-type: application/json' \
  -d '{
    "agent_id": "my-agent",
    "type": "knowledge",
    "uri": "knowledge://users/default/preferences/release-notes",
    "content": "The user prefers concise release notes."
  }'

curl -s -X POST http://127.0.0.1:3000/v1/recall \
  -H 'content-type: application/json' \
  -d '{"agent_id":"my-agent","query":"release notes preference","limit":5}'
```

### Surface before planning

```bash
curl -s -X POST http://127.0.0.1:3000/v1/surface \
  -H 'content-type: application/json' \
  -d '{
    "agent_id": "my-agent",
    "task": "Draft a weekly update for the user",
    "recent_turns": [
      "We need to summarize the sprint.",
      "Keep it short and executive-friendly."
    ],
    "intent": "planning",
    "limit": 5
  }'
```

### Stream lifecycle progress with SSE

```bash
curl -N -X POST http://127.0.0.1:3000/v1/reflect \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"agent_id":"my-agent","phase":"all","stream":true}'
```

### Important routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | liveness |
| `GET` | `/v1/status?agent_id=...` | current memory stats |
| `GET` | `/v1/jobs/:id` | reflect / reindex job status |
| `POST` | `/v1/memories` | create / merge memory |
| `POST` | `/v1/recall` | explicit search |
| `POST` | `/v1/surface` | task-aware surfacing |
| `POST` | `/v1/feedback` | usefulness signal |
| `POST` | `/v1/reflect` | lifecycle maintenance |
| `POST` | `/v1/reindex` | retrieval rebuild |

See [examples/http-api](../../examples/http-api) for ready-to-run payloads.

## Runtime loop: recommended default

```text
process start
  -> boot

for each turn/task
  -> optionally surface(task, recent_turns)
  -> if durable fact detected: remember(...)
  -> if explicit memory lookup needed: recall(...)
  -> if usefulness known: feedback(...)

periodic background job
  -> reflect(all)

embedding provider enabled or changed
  -> reindex
```

## Optional Markdown workflow

If your runtime already keeps human-readable memory files, you can still use
AgentMemory alongside them.

Options:

- import once with `migrate <dir>`
- periodically call `ingest` on markdown content
- enable watcher-based ingest only when you truly have a workspace to watch

For generic runtimes, prefer **explicit ingest** first. Set
`AGENT_MEMORY_AUTO_INGEST=0` unless you intentionally want watcher behavior.

## v5 Features

AgentMemory v5 adds intelligence capabilities that enhance the integration
pattern described above. All features are backward-compatible.

### Memory Links (F1)

Memories are automatically linked to semantically related memories during
writes. Use `related=true` in `recall` or `surface` to expand results with
linked memories. The `link` tool allows manual link management.

### Conflict Detection (F2)

Write Guard now detects contradictions (negation, value changes, status
changes) during writes. Conflicts are reported in the sync result. A
**Conflict Override** rule ensures status updates (e.g. TODO → DONE) are not
incorrectly deduplicated.

### Temporal Recall (F3)

`recall` and `surface` accept `after`, `before`, and `recency_boost` parameters
for time-aware search. Time filtering happens at the SQL layer.

### Passive Feedback (F4)

When `recall` returns results, positive feedback is automatically logged for
the top-3 hits. Rate-limited to 3 passive events per memory per 24 hours.

### Semantic Decay (F5)

The `tidy` phase detects stale content through keyword pattern matching
(e.g. "in progress", "TODO:", "just now"). `identity` and `emotion` types
are exempt.

### Memory Provenance (F6)

Memories can carry `source_session`, `source_context`, and `observed_at`
metadata to track where and when they originated.

## Common mistakes

- **Writing everything**: only store durable memory candidates
- **Skipping lifecycle maintenance**: without `reflect`, memory quality drifts
- **Assuming embeddings are required**: BM25-only is a supported first-class mode
- **Using watcher ingest by default**: disable it unless you actually use a
  markdown workspace workflow
- **Treating surface as recall**: `surface` is proactive context selection,
  not explicit search

## Examples

- [Quick start](../../examples/quick-start)
- [MCP stdio example](../../examples/mcp-stdio)
- [HTTP API example](../../examples/http-api)
