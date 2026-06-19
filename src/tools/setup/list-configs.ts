import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerSetupListConfigs(server: McpServer): void {
  server.registerTool(
    'setup_list_configs',
    {
      title: 'List Config Files',
      description: `List the .env config files available in the working directory and the config/ folder, by wrapping restforge config list.

USE WHEN:
- The user asks which config files exist, e.g. "config apa saja yang ada", "list .env files", "daftar config", "lihat file config"
- Before choosing a config to set as default or to pass to a command

DO NOT USE FOR:
- Showing/setting the DEFAULT config -> use 'setup_get_default_config' / 'setup_set_default_config'
- Reading the values inside a config -> use 'setup_read_env'

This tool runs: npx restforge config list in the given cwd (outputs JSON).

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.

PRESENTATION GUIDANCE:
- Match the user's language. Never mention internal tool names; describe the action.
- Summarise the available .env files and where they are. Keep it concise.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder (must have @restforgejs/platform installed)'),
      },
      annotations: {
        title: 'List Config Files',
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

      const result = await execProcess('npx', ['restforge', 'config', 'list'], { cwd: projectCwd, timeout: 30_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to list config files.

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
- Tell the user the config files could not be listed; summarise the likely cause. Do not paste raw output unless asked. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Config files listed.

Project path: ${projectCwd}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Read the JSON and tell the user which .env files are available (in cwd and config/). Keep it concise. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
