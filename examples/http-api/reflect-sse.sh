#!/usr/bin/env bash
set -euo pipefail

curl -N -X POST http://127.0.0.1:3000/v1/reflect \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"agent_id":"http-demo","phase":"all","stream":true}'
