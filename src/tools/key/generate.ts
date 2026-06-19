import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerKeyGenerate(server: McpServer): void {
  server.registerTool(
    'key_generate',
    {
      title: 'Generate API Key',
      description: `Generate a new API key and write it into an .env file, by wrapping restforge key generate.

USE WHEN:
- The user wants to create/generate a new API key for a RESTForge project, e.g. "buat api key", "generate api key", "bikin key baru"
- The user is setting up authentication and needs a key written to .env

DO NOT USE FOR:
- Listing existing keys -> use 'key_list'
- Revoking a key -> use 'key_revoke'
- Writing arbitrary env values -> use 'setup_write_env'

This tool runs: npx restforge key generate [--output] [--force] in the given cwd.

NON-INTERACTIVE NOTE: if a key already exists in the output file and 'force' is not set, the CLI asks for overwrite confirmation. In this non-interactive context that prompt cannot be answered and the call may stall until timeout — set 'force' to regenerate over an existing key. Generating into a file with no existing key works without 'force'.

SECURITY NOTE: the generated key value is sensitive and will appear in this tool's output. Do not echo it back to the user in plain text unless they ask; the key is written to the .env file.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.

PRESENTATION GUIDANCE:
- Match the user's language. Never mention internal tool names; describe the action (e.g. "generate the API key").
- Confirm the key was written to the target file; do not paste the raw key unless the user explicitly asks for it.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform)'),
        output: z
          .string()
          .min(1)
          .optional()
          .describe('Output .env file to write the key into (relative to cwd; must be INSIDE the project directory — the CLI rejects paths outside cwd). When omitted, the CLI uses its default (.env).'),
        force: z
          .boolean()
          .optional()
          .describe('Overwrite an existing key without confirmation. Set this to regenerate over an existing key (otherwise the CLI may prompt and stall).'),
      },
      annotations: {
        title: 'Generate API Key',
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
      },
    },
    async ({ cwd, output, force }) => {
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
- The user needs to install the RESTForge package before an API key can be generated. Suggest installing it first, then retry. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const args = ['restforge', 'key', 'generate'];
      if (output) args.push(`--output=${output}`);
      if (force) args.push('--force');

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 60_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to generate the API key.

Project path: ${projectCwd}
Output: ${output ?? 'default (.env)'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user the API key was not generated. A common cause is that a key already exists and overwrite was not allowed (the operation may have stalled waiting for confirmation) — suggest retrying with overwrite enabled. Do not paste raw output unless asked. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `API key generated.

Project path: ${projectCwd}
Output: ${output ?? 'default (.env)'}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm the key was written to the target .env file. Treat the key value as a secret: do not repeat it back in plain text unless the user explicitly asks.
- Keep the reply concise. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
