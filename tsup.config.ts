import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "bin/agent-memory": "src/bin/agent-memory.ts",
    "mcp/server": "src/mcp/server.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: false,
  banner: {
    js: "// AgentMemory — Sleep-cycle memory for AI agents",
  },
});
