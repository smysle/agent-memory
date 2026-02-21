# memory-janitor Phase 5: agent-memory Decay + Consistency Check

> Append this to your existing memory janitor prompt (after your existing phases).
> Runs at the end of every janitor execution.

## Prerequisites

- **agent-memory MCP** installed and configured:
  ```bash
  npm install @smyslenny/agent-memory
  ```
  Note: the npm scope is `@smyslenny` while the GitHub repo is `smysle/agent-memory` — both refer to the same project.
- **A memory janitor cron job** — a periodic AI cron that maintains your flat-file memory store.
  See `examples/memory-tidy-prompt.txt` for a full example prompt, and `examples/openclaw-setup.md` for how to schedule it with OpenClaw.
- **A canonical memory file** (optional) — a human-reviewed long-term summary file
  (e.g. `MEMORY.md`, `profile.md`, or any file you manually curate). Only needed for Phase 5.2.
  If you don't have one, skip Phase 5.2 entirely — Phase 5.1 (decay) runs standalone.

---

## Phase 5: agent-memory Decay + Consistency Check

### 5.1 Trigger Ebbinghaus Decay

Call the `agent-memory_reflect` tool with `phase=decay`:

```
agent-memory_reflect({"phase": "decay"})
```

This soft-decays low-vitality memories using the Ebbinghaus curve (`R = e^(-t/S)`).
It does **not** hard-delete — it only lowers vitality scores.
P0 identity memories are protected and never decay.

Record in the final report:
```
agent-memory decay: done, current total N memories
```

### 5.2 Consistency Check (quick scan)

> Skip this phase if you don't maintain a canonical memory file alongside `agent-memory`.

Run a quick spot-check to catch divergence between the two stores.

1. Call `agent-memory_recall` with a query for your most change-prone topic
   (e.g. `"current deployment"`, `"active strategy"`, `"running services"`):
   ```
   agent-memory_recall({"query": "<your most change-prone topic>"})
   ```
2. Compare result against the corresponding section in your canonical memory file
3. Call `agent-memory_recall` with a query for your identity/governance topic
   (e.g. `"identity rules"`, `"agent behavior"`, `"constraints"`):
   ```
   agent-memory_recall({"query": "<your identity/governance topic>"})
   ```
4. Compare result against the identity/rules section in your canonical memory file

**If a clear conflict is found** (e.g., agent-memory says service X is running, canonical file says service Y):
- Mark it as `⚠️ CONFLICT` in the report
- Choose a resolution policy that fits your setup:
  - **Canonical file wins** — treat the human-reviewed file as source of truth; update agent-memory via `agent-memory_remember`
  - **agent-memory wins** — trust the structured store; update the canonical file
  - **Flag for manual review** — output the conflict and let the human decide

The canonical-file-wins policy works well when your summary file is actively maintained by a human. agent-memory-wins works better when the canonical file is rarely updated manually.

**If no conflict:** record `consistency check: OK`

### Final Report — New Fields

Add to your existing janitor report:
```
- agent-memory decay: done, total N memories
- consistency check: OK / skipped (no canonical file) / ⚠️ CONFLICT (describe what conflicted and how it was resolved)
```

---

## Why Decay Needs an External Trigger

`agent-memory`'s decay engine is passive — it only runs when explicitly called. Without a scheduled trigger, memories accumulate indefinitely and vitality scores never decrease. Wiring your janitor to call `reflect(phase=decay)` turns it into the decay scheduler, keeping the memory store healthy over time.

## Why Two Stores Diverge

Agents that write to both `agent-memory` and a flat-file summary will eventually have them drift apart. A deployment change or config update might update one store but not the other. A periodic spot-check at the end of each janitor run catches the most common conflicts before they cause confusion.

## Why Not Automate the Merge?

Intentionally minimal:

- **No automated merging** — conflicts are flagged, not auto-resolved. Auto-merge risks silently overwriting correct data.
- **No bidirectional sync script** — over-engineering for single-agent setups.
- **No semantic comparison** — simple section-level keyword matching is enough for the common cases.

A full bidirectional sync bridge adds complexity without proportional benefit for most setups.
