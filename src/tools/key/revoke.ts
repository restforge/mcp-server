import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerKeyRevoke(server: McpServer): void {
  server.registerTool(
    'key_revoke',
    {
      title: 'Revoke API Key',
      description: `Revoke (remove) an API key from an .env file, by wrapping restforge key revoke.

USE WHEN:
- The user wants to revoke, remove, or invalidate an API key, e.g. "revoke api key", "cabut key", "hapus api key dari .env"

DO NOT USE FOR:
- Generating a key -> use 'key_generate'
- Listing keys -> use 'key_list'

This tool runs: npx restforge key revoke --file=<file> --yes in the given cwd. The 'file' argument is REQUIRED (without it the CLI would drop into an interactive file picker, which cannot be answered here), and '--yes' is always passed to skip the confirmation prompt — so this tool revokes immediately without further confirmation.

IMPORTANT — this is destructive: it removes the key from the named .env file. Confirm the file and intent with the user BEFORE calling this tool, because the revoke happens without an additional in-tool confirmation step.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The named .env file must exist and contain a key. This tool does not pre-check it; the failure response surfaces the cause.

PRESENTATION GUIDANCE:
- Match the user's language. Never mention internal tool names; describe the action (e.g. "revoke the API key").
- Confirm which file the key was revoked from. Keep the reply concise.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform)'),
        file: z
          .string()
          .min(1)
          .describe('Path to the .env file containing the key to revoke (relative to cwd; must be INSIDE the project directory — the CLI rejects paths outside cwd). REQUIRED (avoids the interactive file picker).'),
      },
      annotations: {
        title: 'Revoke API Key',
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
      },
    },
    async ({ cwd, file }) => {
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
- The user needs to install the RESTForge package before an API key can be revoked. Suggest installing it first, then retry. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const args = ['restforge', 'key', 'revoke', `--file=${file}`, '--yes'];

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 30_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to revoke the API key.

Project path: ${projectCwd}
File: ${file}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user the key was not revoked; summarise the likely cause (e.g. the file does not exist or contains no key). Do not paste raw output unless asked. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `API key revoked.

Project path: ${projectCwd}
File: ${file}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm the key was revoked from the named file. Keep the reply concise. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
