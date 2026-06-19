import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerSetupGetDefaultConfig(server: McpServer): void {
  server.registerTool(
    'setup_get_default_config',
    {
      title: 'Get Default Config',
      description: `Show the active default config file for the current working directory, by wrapping restforge config get-default.

USE WHEN:
- The user asks which config is the default, e.g. "config default-nya apa", "show default config", "lihat default config aktif"

DO NOT USE FOR:
- Setting the default -> use 'setup_set_default_config'
- Clearing the default -> use 'setup_clear_default_config'
- Listing all .env files -> use 'setup_list_configs'

This tool runs: npx restforge config get-default in the given cwd (outputs JSON).

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.

PRESENTATION GUIDANCE:
- Match the user's language. Never mention internal tool names; describe the action.
- Tell the user which file is the default (or that none is set). Keep it concise.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder (must have @restforgejs/platform installed)'),
      },
      annotations: {
        title: 'Get Default Config',
        readOnlyHint: true,
        idempotentHint: true,
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

      const result = await execProcess('npx', ['restforge', 'config', 'get-default'], { cwd: projectCwd, timeout: 30_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get the default config.

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
- Tell the user the default config could not be read; summarise the likely cause. Do not paste raw output unless asked. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Default config retrieved.

Project path: ${projectCwd}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Read the JSON and tell the user which file is the active default for this directory, or that none is set. Keep it concise. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
