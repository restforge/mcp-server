import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerSetupSetDefaultConfig(server: McpServer): void {
  server.registerTool(
    'setup_set_default_config',
    {
      title: 'Set Default Config',
      description: `Set a config file as the default for the current working directory (stored in .restforge/defaults.json), by wrapping restforge config set-default. Other commands then fall back to this config when --config is not given.

USE WHEN:
- The user wants to pin/set a default config for a project, e.g. "set default config", "jadikan db.env sebagai default", "pakai config ini sebagai default"
- To avoid passing --config on every command

DO NOT USE FOR:
- Showing the current default -> use 'setup_get_default_config'
- Removing the default -> use 'setup_clear_default_config'
- Writing credentials into the .env -> use 'setup_write_env'

This tool runs: npx restforge config set-default --config=<config> in the given cwd. The config is looked up as: cwd -> config/ folder -> with +.env extension.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.

PRESENTATION GUIDANCE:
- Match the user's language. Never mention internal tool names; describe the action (e.g. "set the default config").
- Confirm which file is now the default. Keep the reply concise.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder (must have @restforgejs/platform installed)'),
        config: z.string().min(1).describe('Config file to set as default. REQUIRED. Looked up: cwd -> config/ -> +.env.'),
      },
      annotations: {
        title: 'Set Default Config',
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
      },
    },
    async ({ cwd, config }) => {
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

      const result = await execProcess('npx', ['restforge', 'config', 'set-default', `--config=${config}`], { cwd: projectCwd, timeout: 30_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to set the default config.

Project path: ${projectCwd}
Config: ${config}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user the default config was not set; summarise the likely cause (e.g. the config file was not found in cwd or config/). Do not paste raw output unless asked. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Default config set.

Project path: ${projectCwd}
Config: ${config}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm the named file is now the default config for this working directory (stored in .restforge/defaults.json). Other commands will use it when no config is specified. Keep the reply concise. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
