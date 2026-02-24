# Changelog

## 3.0.1 (2026-02-24)

### 🛠️ OpenClaw P0 fixes

- **Fixed memory-sync session path mismatch** in cron prompt:
  - removed hardcoded `~/.openclaw/agents/main/sessions/*.jsonl`
  - switched to dynamic discovery with `noah` + env-derived agent path + `main` fallback
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
- Removed stale v2-era claims (embedding/reranker/link/snapshot/hybrid stack narrative)
- Added explicit auto-ingest watcher behavior and env vars

---

## 3.0.0 (2026-02-23)

### 🎉 v3 Simplification

- Repositioned agent-memory as a structured companion to memory-core
- Removed redundant v2 capabilities at API/tooling level
- MCP toolset finalized at 9 tools:
  - `remember`, `recall`, `recall_path`, `boot`, `forget`, `reflect`, `status`, `ingest`, `surface`
- Added narrative warm-boot and human-readable reflect report

---

## 2.x (legacy)

v2.x included embedding/reranker/link/snapshot-era behavior. See git history and design docs for full details.
