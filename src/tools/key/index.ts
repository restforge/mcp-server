import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerKeyGenerate } from './generate.js';
import { registerKeyList } from './list.js';
import { registerKeyRevoke } from './revoke.js';

export function registerKeyTools(server: McpServer): void {
  registerKeyGenerate(server);
  registerKeyList(server);
  registerKeyRevoke(server);
}
