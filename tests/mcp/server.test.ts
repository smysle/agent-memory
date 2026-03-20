import { describe, it, expect } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agent-memory-mcp-test.db";

describe("MCP server tools", () => {
  it("registers expected 11 tools (includes link and reindex)", () => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}

    const { server, db } = createMcpServer(TEST_DB, "test-agent");
    const toolMap = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    const names = Object.keys(toolMap).sort();

    expect(names).toHaveLength(11);
    expect(names).toEqual([
      "boot",
      "forget",
      "ingest",
      "link",
      "recall",
      "recall_path",
      "reflect",
      "reindex",
      "remember",
      "status",
      "surface",
    ]);

    expect(names).not.toContain("snapshot");

    db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });
});
