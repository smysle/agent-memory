#!/bin/bash
# allocate-dd-id.sh — 分配下一个 DesignDoc 编号
# Usage: ./allocate-dd-id.sh <slug>
# Output: 编号 (e.g., 0001) 并更新 .next-id

set -euo pipefail

DD_DIR="$(dirname "$0")"
NEXT_ID_FILE="$DD_DIR/.next-id"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <slug>" >&2
  exit 1
fi

SLUG="$1"
CURRENT_ID=$(cat "$NEXT_ID_FILE" 2>/dev/null || echo "1")
PADDED_ID=$(printf "%04d" "$CURRENT_ID")
NEXT_ID=$((CURRENT_ID + 1))

echo "$NEXT_ID" > "$NEXT_ID_FILE"
echo "$PADDED_ID"
