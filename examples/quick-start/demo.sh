#!/usr/bin/env bash
set -euo pipefail

export AGENT_MEMORY_DB="${AGENT_MEMORY_DB:-./agent-memory.db}"
export AGENT_MEMORY_AGENT_ID="${AGENT_MEMORY_AGENT_ID:-quick-start}"

npx agent-memory init

npx agent-memory remember \
  "Alice prefers short weekly summaries." \
  --type knowledge \
  --uri knowledge://users/alice/preferences/summaries

npx agent-memory remember \
  "Alice is preparing a board update for Friday." \
  --type event \
  --uri event://calendar/alice/board-update

npx agent-memory remember \
  "Keep replies direct and low-jargon when talking to Alice." \
  --type identity \
  --uri core://assistant/style/alice

npx agent-memory recall "Alice summary preference" --limit 5
npx agent-memory boot
npx agent-memory reflect all
