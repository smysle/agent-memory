# OpenClaw Setup Guide

> Configuration for running AgentMemory v5 on OpenClaw.
> Tested with Claude Opus 4.6 and OpenClaw's cron + MCP integration.

## Directory Structure

```
~/.openclaw/workspace/
├── MEMORY.md                    # Long-term memory (≤200 lines, curated)
├── memory/
│   ├── 2026-03-20.md           # Today's journal (raw daily notes)
│   ├── 2026-03-19.md           # Yesterday
│   ├── ...                     # Recent 7 days kept as-is
│   ├── weekly/
│   │   └── 2026-03-09.md      # Weekly summaries (compressed from dailies)
│   ├── archive/
│   │   ├── 2026-03-01.md      # Archived dailies (post-compression)
│   │   └── MEMORY.md.bak-*    # MEMORY.md backups before tidy
│   └── heartbeat-state.json    # Heartbeat check timestamps
└── agent-memory.db              # AgentMemory SQLite database
```

## MCP Server Configuration

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
        "AGENT_MEMORY_AUTO_INGEST_DAILY": "0",
        "AGENT_MEMORY_WORKSPACE": "~/.openclaw/workspace"
      }
    }
  }
}
```

### Notes

- `AGENT_MEMORY_AUTO_INGEST=1` enables file watching — makes sense for OpenClaw
  workspaces that maintain `MEMORY.md`.
- `AGENT_MEMORY_AUTO_INGEST_DAILY=0` (default) skips daily log files
  (`YYYY-MM-DD.md`). Daily logs should go through the memory-sync cron pipeline
  instead of raw ingest.
- Set `AGENT_MEMORY_AGENT_ID` to your agent's name (e.g. `my-agent`).

## Cron Jobs

### memory-sync (Light Sleep) — 14:00 & 22:00 daily

The memory-sync cron extracts durable observations from recent sessions,
appends them to today's journal, and syncs important items into AgentMemory
via `remember`.

In v4.0+ (LLM cleansing), the sync prompt instructs the LLM to:
1. Read recent session messages
2. Classify each as `knowledge`, `emotion`, or `event`
3. Deduplicate against today's existing journal
4. Append new bullets to `memory/YYYY-MM-DD.md`
5. Sync durable items to AgentMemory with provenance metadata

```bash
openclaw cron add \
  --name memory-sync \
  --cron "0 14,22 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --no-deliver \
  --timeout-seconds 300 \
  --message "<your memory-sync prompt>"
```

> **Tip:** Write your own sync prompt tailored to your agent. A good sync
> prompt should include deduplication logic, classification rules, and
> provenance metadata (`source_session`, `source_context`, `observed_at`).

### memory-tidy (Deep Sleep) — 03:00 daily

The memory-tidy cron compresses old journals, distills long-term memory,
and runs AgentMemory lifecycle maintenance.

```bash
openclaw cron add \
  --name memory-tidy \
  --cron "0 3 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --announce \
  --best-effort-deliver \
  --timeout-seconds 600 \
  --message "<your memory-tidy prompt>"
```

A typical tidy prompt covers:
1. Compress dailies older than 7 days into weekly summaries
2. Deduplicate recent journals
3. Distill important facts into `MEMORY.md` (200-line limit)
4. Run `reflect all` for AgentMemory lifecycle maintenance (decay, tidy, govern)
5. Consistency check between `MEMORY.md` and AgentMemory (see `memory-janitor-phase5.md`)

## v5 Features for OpenClaw Users

AgentMemory v5 adds six intelligence features that enhance the cron pipeline:

### Memory Provenance (F6)

When calling `remember` from your sync prompt, include provenance metadata:

```
remember(content="...", type="knowledge",
  source_session="session-id-here",
  source_context="extracted from 14:00 sync",
  observed_at="2026-03-20T14:00:00+08:00")
```

This tracks where and when each memory originated.

### Temporal Recall (F3)

Use `after` and `before` to filter memories by time:

```
recall(query="deployment decisions", after="2026-03-01", recency_boost=true)
```

### Memory Links (F1)

The `link` tool allows manual association between memories:

```
link(source_id=42, target_id=57)
```

Set `related=true` in `recall` or `surface` to expand results with linked memories.

### Conflict Detection (F2)

Write Guard now detects contradictions during writes. If a new memory
conflicts with an existing one (e.g., status change from TODO to DONE),
the conflict is reported and the write proceeds as an update rather than
being silently deduplicated.

## Recommended Architecture

```
Journal writes (real-time)
  │
  ├─ MEMORY.md ←── auto-ingest watcher (safety net)
  │
  └─ memory/YYYY-MM-DD.md
       │
       ├─ memory-sync cron (14:00/22:00)
       │    └─ LLM cleansing → select durable items → remember with provenance
       │
       └─ memory-tidy cron (03:00)
            └─ Compress old dailies → distill MEMORY.md → reflect all
```

## Key Lessons Learned

1. **memory-sync MUST deduplicate** — Without dedup, sync writes the same events repeatedly
2. **Emotional interactions > technical logs** — Prioritize what the user said/felt
3. **200-line hard limit on MEMORY.md** — Forces curation; use 4-criterion gate before writing
4. **best-effort-deliver for tidy** — Announce failures shouldn't mark the job as errored
5. **Daily journals are raw; MEMORY.md is curated** — Like human notes vs. long-term memory
6. **Use provenance metadata** — `source_session` and `observed_at` help debug where memories came from

## Wiring a Memory Janitor to agent-memory

### What is a memory janitor?

A **memory janitor** is a periodic AI cron job that maintains your flat-file
memory store (daily journals, long-term summary file). It is not a separate
package — you define it yourself as an OpenClaw cron job with a prompt.

A typical janitor runs 2–4x per day and executes phases like:
- Compress old daily journals into weekly summaries
- Deduplicate repeated entries
- Distill important facts into a long-term summary file

### Adding agent-memory integration to your janitor

If you run a memory janitor alongside `agent-memory`, add a final phase to your
janitor prompt to handle two gaps. See `memory-janitor-phase5.md` for the
complete template covering:

1. Triggering Ebbinghaus decay via `reflect(phase=decay)`
2. Running a consistency check between `agent-memory` and your canonical memory file
3. Reporting results

#### Gap 1: Decay never fires automatically

`agent-memory`'s Ebbinghaus decay engine is passive — it only runs when you
explicitly call `reflect(phase=decay)`. Your janitor becomes the decay scheduler.

#### Gap 2: Two stores silently diverge

Agents that maintain both `agent-memory` and a canonical memory file will
eventually have them drift apart. A periodic consistency check catches conflicts.
