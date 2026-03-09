# MCP stdio Example

This example is for hosts that can launch an MCP server over stdio.

## Install

```bash
npm install @smyslenny/agent-memory
```

## Example config

Use the sample config in this directory as a starting point:

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["./node_modules/@smyslenny/agent-memory/dist/mcp/server.js"],
      "env": {
        "AGENT_MEMORY_DB": "./agent-memory.db",
        "AGENT_MEMORY_AGENT_ID": "mcp-demo",
        "AGENT_MEMORY_AUTO_INGEST": "0"
      }
    }
  }
}
```

## Suggested tool usage

- on startup → `boot`
- when a durable fact appears → `remember`
- when the runtime needs an answer from memory → `recall`
- before planning or replying → `surface`
- on a schedule → `reflect`
- after enabling embeddings → `reindex`

## Files

- `mcp-server.json` — sample MCP server entry
