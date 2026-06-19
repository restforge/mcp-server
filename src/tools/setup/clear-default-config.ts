import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerSetupClearDefaultConfig(server: McpServer): void {
  server.registerTool(
    'setup_clear_default_config',
    {
      title: 'Clear Default Config',
      description: `Remove the default config for the current working directory, by wrapping restforge config clear-default. After clearing, commands no longer fall back to a default and require --config explicitly.

USE WHEN:
- The user wants to unset/clear the default config, e.g. "hapus default config", "clear default config", "reset default config"

DO NOT USE FOR:
- Setting the default -> use 'setup_set_default_config'
- Showing the default -> use 'setup_get_default_config'

This tool runs: npx restforge config clear-default in the given cwd (no other flags).

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.

PRESENTATION GUIDANCE:
- Match the user's language. Never mention internal tool names; describe the action.
- Confirm the default was cleared. Note this is reversible by setting a default again. Keep it concise.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder (must have @restforgejs/platform installed)'),
      },
      annotations: {
        title: 'Clear Default Config',
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
      },
    },
    async ({ cwd }) => {
      const projectCwd = resolve(cwd);
      try {
        await access(join(projectCwd, 'node_modules', '@restforgejs', 'platform'));
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the RESTForge package is not installed in this project.

Project path: ${projectCwd}
Expected location: node_modules/@restforgejs/platform

For the assistant:
- The user needs to install the RESTForge package first, then retry. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const result = await execProcess('npx', ['restforge', 'config', 'clear-default'], { cwd: projectCwd, timeout: 30_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to clear the default config.

Project path: ${projectCwd}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user the default config could not be cleared; summarise the likely cause (e.g. no default was set). Do not paste raw output unless asked. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Default config cleared.

Project path: ${projectCwd}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm the working-directory default config was removed; commands will now require an explicit config. This is reversible by setting a default again. Keep it concise. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
