import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDataPull } from './pull.js';
import { registerDataPush } from './push.js';

export function registerDataTools(server: McpServer): void {
  registerDataPull(server);
  registerDataPush(server);
}
