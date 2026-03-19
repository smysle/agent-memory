# Changelog

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
