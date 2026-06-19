import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerProjectList } from './list.js';
import { registerProjectDelete } from './delete.js';

export function registerProjectTools(server: McpServer): void {
  registerProjectList(server);
  registerProjectDelete(server);
}
