# OpenClaw Setup Guide

> Battle-tested configuration for running AgentMemory on OpenClaw.
> Used in production since 2026-02-12 with Claude Opus 4.6.

## Directory Structure

```
~/.openclaw/workspace/
├── MEMORY.md                    # Long-term memory (≤200 lines, curated)
├── memory/
│   ├── 2026-02-20.md           # Today's journal (raw daily notes)
│   ├── 2026-02-19.md           # Yesterday
│   ├── ...                     # Recent 7 days kept as-is
│   ├── weekly/
│   │   └── 2026-02-09.md      # Weekly summaries (compressed from dailies)
│   ├── archive/
│   │   ├── 2026-02-12.md      # Archived dailies (post-compression)
│   │   └── MEMORY.md.bak-*    # MEMORY.md backups before tidy
│   └── heartbeat-state.json    # Heartbeat check timestamps
```

## Cron Jobs

### memory-sync (Light Sleep) — 14:00 & 22:00 daily

```bash
openclaw cron add \
  --name memory-sync \
  --cron "0 14,22 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --no-deliver \
  --timeout-seconds 300 \
  --message "$(cat memory-sync-prompt.txt)"
```

### memory-tidy (Deep Sleep) — 03:00 daily

```bash
openclaw cron add \
  --name memory-tidy \
  --cron "0 3 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --announce \
  --best-effort-deliver \
  --timeout-seconds 600 \
  --message "$(cat memory-tidy-prompt.txt)"
```

## Semantic Search (qmd)

```json
// openclaw.json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "command": "/home/user/.bun/bin/qmd",
      "timeoutMs": 600000
    },
    "includeDefaultMemory": true
  }
}
```

## Key Lessons Learned

1. **memory-sync MUST deduplicate** — Without dedup, sync writes the same events repeatedly (we had 7x duplicates in one file)
2. **Emotional interactions > technical logs** — Prioritize what the user said/felt over command outputs
3. **200-line hard limit on MEMORY.md** — Forces curation; use 4-criterion gate before writing
4. **best-effort-deliver for tidy** — Announce failures shouldn't mark the job as errored
5. **qmd timeout needs 600s on CPU** — Model reload per query is slow without GPU; daemon mode helps but isn't required
6. **Daily journals are raw; MEMORY.md is curated** — Like human notes vs. long-term memory
