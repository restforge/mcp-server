import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHealthPing } from './ping.js';

export function registerHealthTools(server: McpServer, version: string): void {
  registerHealthPing(server, version);
}
