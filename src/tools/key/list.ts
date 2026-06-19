import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerKeyList(server: McpServer): void {
  server.registerTool(
    'key_list',
    {
      title: 'List API Keys',
      description: `List the registered API keys found in .env files (masked by default), by wrapping restforge key list.

USE WHEN:
- The user wants to see which API keys exist, e.g. "lihat api key", "daftar key", "list api keys", "key apa saja yang terdaftar"

DO NOT USE FOR:
- Generating a new key -> use 'key_generate'
- Revoking a key -> use 'key_revoke'

This tool runs: npx restforge key list [--show-full] [--dir] in the given cwd.

SECURITY NOTE: by default keys are shown MASKED. 'showFull' reveals the full secret key values in this tool's output — only enable it when the user explicitly asks, and avoid repeating full keys back to the user.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.

PRESENTATION GUIDANCE:
- Match the user's language. Never mention internal tool names; describe the action (e.g. "list the API keys").
- Summarise how many keys are present and where; keep masked values masked. Do not paste full key values unless the user explicitly asked and 'showFull' was used.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform)'),
        showFull: z
          .boolean()
          .optional()
          .describe('Reveal full (unmasked) key values. SECURITY: only when the user explicitly asks. When omitted, keys are masked.'),
        dir: z
          .string()
          .min(1)
          .optional()
          .describe('Directory to search for .env files. When omitted, the CLI uses the current working directory.'),
      },
      annotations: {
        title: 'List API Keys',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, showFull, dir }) => {
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
- The user needs to install the RESTForge package before API keys can be listed. Suggest installing it first, then retry. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const args = ['restforge', 'key', 'list'];
      if (showFull) args.push('--show-full');
      if (dir) args.push(`--dir=${dir}`);

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 30_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to list API keys.

Project path: ${projectCwd}
Dir: ${dir ?? 'cwd'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user the keys could not be listed; summarise the likely cause from the output (e.g. the search directory does not exist). Do not paste raw output unless asked. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `API keys listed${showFull ? ' (FULL/unmasked)' : ' (masked)'}.

Project path: ${projectCwd}
Dir: ${dir ?? 'cwd'}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Read the output and tell the user how many keys are present and in which file(s).
- ${showFull ? 'Full key values were requested; still avoid repeating the secrets back unless necessary.' : 'Values are masked; do not attempt to unmask unless the user explicitly asks.'}
- Keep the reply concise. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
