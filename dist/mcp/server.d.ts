import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { o as openDatabase } from '../db-CMsKtBt0.js';
import 'better-sqlite3';

declare function createMcpServer(dbPath?: string, agentId?: string): {
    server: McpServer;
    db: ReturnType<typeof openDatabase>;
};

export { createMcpServer };
