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

## Wiring a Memory Janitor to agent-memory

### What is a memory janitor?

A **memory janitor** is a periodic AI cron job that maintains your flat-file memory store (daily journals, long-term summary file). It is not a separate package — you define it yourself as an OpenClaw cron job with a prompt that instructs the agent to compress, deduplicate, and distill memories.

A typical janitor runs 2–4x per day and executes phases like:
- Compress old daily journals into weekly summaries
- Deduplicate repeated entries
- Distill important facts into a long-term summary file (e.g. `MEMORY.md` or any canonical memory file you maintain)

See `examples/memory-tidy-prompt.txt` in this repo for a full example prompt, and the cron setup above for how to schedule it.

### Adding agent-memory integration to your janitor

If you run a memory janitor alongside `agent-memory`, add a final phase to your janitor prompt to handle two gaps that aren't solved by either system alone.

#### Gap 1: Decay never fires automatically

`agent-memory`'s Ebbinghaus decay engine is passive — it only runs when you explicitly call `reflect(phase=decay)`. Without an external trigger, memories accumulate indefinitely with no vitality decay.

**Fix:** Call `agent-memory_reflect(phase=decay)` at the end of every janitor run. Your janitor becomes the decay scheduler.

#### Gap 2: Two stores silently diverge

Agents that maintain both `agent-memory` and a separate canonical memory file will eventually have them drift apart. A deployment change, a config update, or a strategy swap might update one store but not the other.

**Fix:** Add a quick consistency check at the end of each janitor run. Spot-check the highest-conflict sections (e.g. current deployments, identity rules). Flag conflicts and resolve them — treating your human-reviewed canonical file as source of truth is one reasonable policy, but you can also choose to trust `agent-memory` or prompt for manual review.

#### How to add this to your janitor prompt

Append the Phase 5 template from `examples/memory-janitor-phase5.md` to your existing janitor prompt. It covers:
1. Triggering decay via `agent-memory_reflect`
2. Running a consistency check between `agent-memory` and your canonical memory file
3. Reporting results

#### Lesson learned

We ran agent-memory for ~3 days before noticing decay had never fired. All memories still had their initial vitality scores. Adding the janitor trigger fixed this immediately. The consistency check caught a real deployment status mismatch on day 1.
