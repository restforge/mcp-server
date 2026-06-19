import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRuntimeDetectProject } from './detect-project.js';
import { registerRuntimeDetectConfig } from './detect-config.js';
import { registerRuntimeValidatePreflight } from './validate-preflight.js';
import { registerRuntimeCheckLauncherExists } from './check-launcher-exists.js';
import { registerRuntimeGenerateLauncher } from './generate-launcher.js';
import { registerRuntimeCheckStatus } from './check-status.js';

export function registerRuntimeTools(server: McpServer): void {
  registerRuntimeDetectProject(server);
  registerRuntimeDetectConfig(server);
  registerRuntimeValidatePreflight(server);
  registerRuntimeCheckLauncherExists(server);
  registerRuntimeGenerateLauncher(server);
  registerRuntimeCheckStatus(server);
}
