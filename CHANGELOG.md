# Changelog

## 5.1.0 (2026-03-20)

### ✨ Features

#### Archive on Eviction (淘汰归档)

- Memories evicted by governance are now **archived** to `memory_archive` instead
  of permanently deleted. Only memories with `vitality ≥ 0.1` are archived;
  lower-vitality memories (decayed noise) are still directly deleted.
- New schema v8: adds `memory_archive` table (migration `v7 → v8` runs
  automatically on startup).
- New core functions: `archiveMemory()`, `restoreMemory()`, `listArchivedMemories()`,
  `purgeArchive()`.
- New MCP tool **`archive`**: `list` / `restore` / `purge` actions for managing
  archived memories.
- `GovernResult` now includes `archived` (count of memories actually written to
  the archive table) and `evictedByType` breakdown.

#### Tiered Capacity (分层容量)

- Governance now enforces **per-type capacity limits** before the global cap.
  Defaults: `identity: unlimited`, `emotion: 50`, `knowledge: 250`, `event: 50`,
  `total: 350`.
- Configurable via environment variables: `AGENT_MEMORY_MAX_IDENTITY`,
  `AGENT_MEMORY_MAX_EMOTION`, `AGENT_MEMORY_MAX_KNOWLEDGE`,
  `AGENT_MEMORY_MAX_EVENT`, `AGENT_MEMORY_MAX_MEMORIES`.
- `status` MCP tool now returns a `capacity` object showing per-type counts and
  limits.
- Identity memories (P0) are **never evicted** unless an explicit
  `AGENT_MEMORY_MAX_IDENTITY` is set.

### ♻️ Notes

- Tidy phase (`runTidy`) still deletes low-vitality memories directly — no
  archiving. Only govern-phase evictions (capacity-based) go to the archive.
- All new parameters have defaults; upgrading from 5.0.x requires no config
  changes. Schema migration is automatic.

## 5.0.1 (2026-03-20)

### 🐛 Fixes

- **auto-ingest**: Daily log files (`YYYY-MM-DD.md`) are now skipped by default.
  Only `MEMORY.md` (curated memory) is watched and ingested. Daily logs are raw
  journals that often contain noise — they should be processed through the
  memory-sync cron pipeline instead.
- New environment variable `AGENT_MEMORY_AUTO_INGEST_DAILY=1` restores the
  previous behavior of ingesting all `.md` files in the `memory/` directory.

## 5.0.0 (2026-03-20)

### 🧠 Memory Intelligence

v5 is a major feature release that adds six intelligence capabilities to the
memory layer. All features are backward-compatible with v4 workflows.

Design document: see the v5 feature table in [README.md](README.md).

#### F1: Memory Links (记忆关联)

- Automatic link creation during `syncOne()`: after a successful `add` or
  `merge`, candidates with `dedup_score ∈ [0.45, 0.82)` are saved as `related`
  links (up to 5 per memory)
- `recall` and `surface` accept a new `related: boolean` parameter. When true,
  top-K results are expanded with linked memories from the `links` table
  (capped at `limit * 1.5`, with score scaled by `original_score * link_weight * 0.6`)
- Related memories are tagged with `match_type: 'related'` and
  `related_source_id` in results so the agent knows why they appeared
- New MCP tool **`link`**: manually create or remove associations
  (`relation`: `related` | `supersedes` | `contradicts`, with optional `weight`)

#### F2: Conflict Detection (冲突检测)

- Write Guard (`guard.ts`) now iterates over multiple candidates instead of
  only the top-1 match
- Three conflict signal types detected between incoming content and existing
  candidates:
  - **Negation**: one side contains negation words the other does not
  - **Value**: same entity with different numeric values (IPs, ports, versions)
  - **Status**: one side marked done/cancelled while the other is in-progress
- Conflict score (0–1) is computed from weighted signals. Conflicts above 0.5
  are reported in `GuardResult.conflicts` and propagated to `SyncResult`
- **Conflict Override rule**: when `dedup_score ≥ 0.93` and a `status` or
  `value` conflict is detected, the guard action is forced from `skip` to
  `update` — preventing legitimate state changes (e.g. TODO → DONE) from being
  silently deduplicated. `negation` conflicts do not trigger override (higher
  false-positive rate)
- Writes are never blocked by conflict detection — the agent decides what to do

#### F3: Temporal Recall (时间维度召回)

- `recall` and `surface` accept new optional parameters:
  - `after` / `before` (ISO 8601) — time-range filter at the SQL layer for
    both BM25 and vector search paths
  - `recency_boost` (0–1) — blends a recency decay signal into the fusion
    score: `final = (1 - boost) * base + boost * e^(-days/30)`
- BM25 and vector search functions (`searchBM25`, `searchByVector`) extended
  with `after` / `before` filter support

#### F4: Passive Feedback (被动反馈)

- `FeedbackSource` type extended to `"recall" | "surface" | "passive"`
- When `recall` records access, the top-3 results automatically receive a
  positive passive feedback event (value 0.7, vs 1.0 for explicit feedback)
- Rate-limited: max 3 passive feedback events per memory per 24-hour window
- Anti-N+1: deduplication check uses a single batch `WHERE memory_id IN (...)`
  query instead of per-memory `SELECT COUNT(*)`

#### F5: Semantic Decay (语义衰减)

- New `isStaleContent(content, type)` function in `tidy.ts` detects
  temporally-stale content via keyword pattern matching
- Pattern sets are scoped by memory type:
  - `event`: broad matching (e.g. `正在`, `in progress`, `TODO`, `just now`)
  - `knowledge`: anchored-start-only patterns (e.g. `^TODO:`, `^WIP:`) to
    avoid false positives on knowledge descriptions containing those words
  - `identity` and `emotion`: exempt from semantic decay
- Age thresholds: `in_progress` > 7d, `pending` > 14d, `ephemeral` > 3d
- Matched memories have their `vitality` multiplied by the pattern's
  `decay_factor`
- `TidyResult` now includes `staleDecayed` count

#### F6: Memory Provenance (记忆溯源)

- Schema migration v6 → v7: three new nullable columns on `memories`:
  - `source_session` — originating session ID
  - `source_context` — trigger context (≤200 chars)
  - `observed_at` — when the event actually happened (distinct from write time)
- `Memory` interface and `CreateMemoryInput` updated with provenance fields
- MCP `remember` tool accepts `session_id`, `context`, `observed_at`
- `recall` / `surface` results include provenance fields when present
- `guard.ts` `timeProximity()` now prefers `observed_at` over regex-guessed
  timestamps from content/URI/source

### 🧰 Tooling

- MCP toolset expanded from **10 → 11 tools** (added `link`)
- MCP server version string updated to `5.0.0`

### ✅ Tests

- Added `tests/v5/intelligence.test.ts` with **25 new test cases** covering
  all six v5 features
- Total test count: **96** (up from 69 in v4.2)

### 📦 Schema

- Database schema version: **7** (from 6)
- Migration is additive (nullable columns only) — safe to upgrade in place
- Rollback: ignore new columns, delete new link/feedback rows by type

---

## 4.2.0 (2026-03-19)

### 🛡️ Anti-Noise Hardening

This release addresses the "heartbeat flood" problem where memory-sync cron
ingested hundreds of low-value status observations (e.g. "HEARTBEAT_OK",
"安静模式", "PR 无变化") into the curated memory store.

#### Guard improvements
- **Raised specificity threshold** for P2/P3 memories from 8 to 20 effective
  characters
- **CJK-aware length calculation**: CJK characters count as 3 effective chars
  (reflecting their higher information density vs ASCII), preventing false
  rejections of legitimate Chinese content

#### Ingest noise filter
- Added `isIngestNoise()` pre-filter in `extractIngestItems()` that skips lines
  matching known noise patterns before they reach the Write Guard:
  - Heartbeat status: `HEARTBEAT_OK`, `安静模式`, `不打扰`, `继续安静待命`
  - Empty deltas: `无新 delta`, `无变化`, `无紧急`, `无新进展`
  - System dumps: `openclaw status`, `openclaw gateway status`, `session_status`
  - Stale PR observations: `PR #NNN 无变化`, `基线未变`, `轻量复查`
  - Cron noise: `cron 会话`, `距上次心跳`, `危险区协议`

#### Tidy expansion
- `getDecayedMemories()` now includes **P2 (knowledge)** in cleanup candidates
  (previously only P3 event). This means decayed low-vitality knowledge entries
  will be cleaned up during sleep tidy, not just events.

#### Govern env config
- `maxMemories` can now be set via `AGENT_MEMORY_MAX_MEMORIES` environment
  variable (default: 200)

### ✅ Tests
- 66 tests passing (19 files)
- Added `tests/ingest/noise-filter.test.ts` covering heartbeat noise rejection,
  meaningful content preservation, and mixed signal/noise handling

## 4.0.0-alpha.1 (2026-03-09)

### 🚀 Repositioning

AgentMemory v4 is now documented and packaged as an **agent-native memory layer
with lifecycle management**.

What changed at the product level:

- README is now **English-first** and generic-runtime-first
- OpenClaw is still supported, but now documented as an **optional host example**
- `memory/*.md + MEMORY.md` is treated as an **optional workflow**, not the
  product definition
- CLI, MCP stdio, and HTTP/SSE are all first-class integration paths

### ✨ Added in Phase 1 — optional vector retrieval layer

- Added **optional embedding provider support** for hybrid retrieval:
  - `openai-compatible`
  - `local-http`
- Added **hybrid recall** with BM25 + vector fusion
- Added embedding-aware storage and reindex support:
  - `provider_id`
  - `content_hash`
  - `status`
- Added **`reindex`** support for backfill / rebuild workflows
- Added provider configuration via environment variables:
  - `AGENT_MEMORY_EMBEDDING_PROVIDER`
  - `AGENT_MEMORY_EMBEDDING_BASE_URL`
  - `AGENT_MEMORY_EMBEDDING_MODEL`
  - `AGENT_MEMORY_EMBEDDING_DIMENSION`
  - `AGENT_MEMORY_EMBEDDING_API_KEY`
- Kept **BM25-only mode** as a supported fallback when no provider is configured

### ✨ Added in Phase 2 — semantic dedup + lifecycle reliability

- Upgraded **Write Guard** from simple duplicate checks to semantic dedup flow
- Added **typed merge policy** so similar memories can be merged more safely
- Added **maintenance job tracking** for lifecycle operations
- Added checkpoint-aware **reflect orchestrator** for:
  - `decay`
  - `tidy`
  - `govern`
- Improved lifecycle observability and recovery-friendliness for interrupted
  maintenance runs

### ✨ Added in Phase 3 — HTTP/SSE API + better surface

- Added long-lived **HTTP API** transport
- Added **SSE progress streaming** for long-running jobs
- Added HTTP routes for:
  - `POST /v1/memories`
  - `POST /v1/recall`
  - `POST /v1/surface`
  - `POST /v1/feedback`
  - `POST /v1/reflect`
  - `POST /v1/reindex`
  - `GET /v1/status`
  - `GET /v1/jobs/:id`
  - `GET /health`
- Added CLI server mode:
  - `agent-memory serve`
- Upgraded **surface** into a more **context-aware** API using:
  - `task`
  - `query`
  - `recent_turns`
  - `intent`
  - type filters
  - feedback priors
- Added **feedback events** so runtimes can record whether `recall` / `surface`
  results were actually useful

### 🧰 Tooling / interface changes

- MCP toolset is now **10 tools**:
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
- CLI now includes:
  - `db:migrate`
  - `reindex`
  - `serve`

### 📚 Documentation and examples overhaul

- Rewrote `README.md` for OSS evaluation and generic runtime adoption
- Removed the split `README.md` / `README.en.md` homepage model
- Added dedicated docs:
  - `docs/architecture.md`
  - `docs/integrations/generic.md`
  - `docs/integrations/openclaw.md`
  - `docs/migration-v3-v4.md`
- Reorganized examples into:
  - `examples/quick-start/`
  - `examples/http-api/`
  - `examples/mcp-stdio/`
  - `examples/openclaw/`

### ✅ Compatibility notes

- Existing CLI and MCP usage remains available
- HTTP/SSE is **additive**, not a replacement
- Existing SQLite deployments can upgrade incrementally
- Full embeddings are **optional** and can be enabled later with `reindex`

---

## 3.0.1 (2026-02-24)

### 🛠️ OpenClaw P0 fixes

- **Fixed memory-sync session path mismatch** in cron prompt:
  - removed hardcoded `~/.openclaw/agents/main/sessions/*.jsonl`
  - switched to dynamic discovery with `noah` + env-derived agent path + `main`
    fallback
- **Aligned memory-tidy prompt** with the same session path health check strategy
- **Added memory-sync health output contract**:
  - `session_scan_glob`
  - `session_file_count`
  - `latest_session_file`
  - `extracted_message_count`
  - `appended_bullet_count`
  - `synced_memory_count`
  - `sync_error_count`

### ✨ Auto-ingest watcher implemented

- Added `fs.watch`-based auto-ingest watcher for:
  - `~/.openclaw/workspace/memory/*.md`
  - `~/.openclaw/workspace/MEMORY.md`
- New module: `src/ingest/watcher.ts`
- MCP server now starts watcher by default (configurable):
  - `AGENT_MEMORY_AUTO_INGEST=0` to disable
  - `AGENT_MEMORY_WORKSPACE` to override workspace path

### 🧱 Ingest refactor + tests

- Extracted ingest core logic from MCP server into reusable module:
  - `src/ingest/ingest.ts`
- MCP `ingest` tool now delegates to shared `ingestText()`
- Added ingest tests:
  - dry-run extraction does not write DB
  - source marker stored as `auto:{source}`

### 📚 Documentation realigned to v3 reality

- Rewrote `README.md` and `README.en.md` to match actual v3 capabilities
- Removed stale v2-era claims (embedding/reranker/link/snapshot/hybrid stack
  narrative)
- Added explicit auto-ingest watcher behavior and env vars

---

## 3.0.0 (2026-02-23)

### 🎉 v3 Simplification

- Repositioned agent-memory as a structured companion to memory-core
- Removed redundant v2 capabilities at API/tooling level
- MCP toolset finalized at 9 tools:
  - `remember`, `recall`, `recall_path`, `boot`, `forget`, `reflect`, `status`,
    `ingest`, `surface`
- Added narrative warm-boot and human-readable reflect report

---

## 2.x (legacy)

v2.x included embedding/reranker/link/snapshot-era behavior. See git history and
design docs for full details.
