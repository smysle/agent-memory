# Quick Start Example

This is the smallest end-to-end AgentMemory example.

## Goal

In a few commands, you will:

1. create a database
2. store a few memories
3. recall them
4. run a lifecycle pass

## Run it

```bash
npm install @smyslenny/agent-memory
export AGENT_MEMORY_DB=./agent-memory.db
export AGENT_MEMORY_AGENT_ID=quick-start

./examples/quick-start/demo.sh
```

Or copy the commands from the script directly.

## What this example demonstrates

- CLI-first setup
- typed memory writes
- URI paths
- explicit recall
- lifecycle maintenance with `reflect all`

If you want runtime integration examples instead of a shell demo, see:

- [HTTP API example](../http-api)
- [MCP stdio example](../mcp-stdio)
- [OpenClaw example](../openclaw)
