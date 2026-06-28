import { z } from 'zod';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDesignerAuthRemove(server: McpServer): void {
  server.registerTool(
    'designer_auth_remove',
    {
      title: 'Remove Embedded Frontend Auth',
      description: `Remove embedded auth (rfx_auth) from a RESTForge frontend project — deletes login.html,
signup.html, js/rfx_auth.js, strips the auth guard from all app pages, and removes the
embeddedAuth marker from payload/app-config.json.

USE WHEN:
- The user wants to remove/uninstall embedded auth from a frontend project
- The user asks things like "hapus auth frontend", "uninstall rfx_auth", "cabut auth embedded",
  "remove embedded auth", "balikin ke sebelum pasang auth"
- The frontend project has embedded auth installed (via 'designer_auth_create')

DO NOT USE FOR:
- Installing embedded auth -> use 'designer_auth_create'
- Removing the vanilla-js-auth plugin -> out of scope (different mechanism)
- Backend auth removal -> out of scope (no equivalent CLI command)

This tool wraps: npx restforge-designer auth --remove --project=<project> [--frontend-path] --force,
run in the given cwd.

IMPORTANT — confirmation behaviour: the CLI normally prompts for y/N confirmation before removing.
In this non-interactive MCP context, --force is ALWAYS passed to skip the prompt.
ALWAYS confirm with the user that they intend to remove auth before calling this tool.

What this command does (in order):
1. Detects whether auth is installed (checks files + embeddedAuth marker)
2. Deletes login.html, signup.html, js/rfx_auth.js
3. Strips the auth guard <script src="js/rfx_auth.js"> from all *.html pages (other content untouched)
4. Removes the embeddedAuth key from payload/app-config.json (other keys preserved)

Idempotent: no-op if auth is not installed; running --remove twice is safe.

Preconditions:
- RESTForge Designer is invoked via 'npx restforge-designer' (the binary is bundled with the @restforgejs/platform package). This tool pre-checks
  that by running 'npx restforge-designer --version'.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user.
- ALWAYS confirm with the user before calling this tool (list project name, what will be deleted).
- Summarise what was removed: files deleted, pages unguarded, marker removed.
- When auth was not installed (no-op), tell the user clearly.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the working directory where the binary is run'),
        project: z
          .string()
          .min(1)
          .describe('Frontend project name to remove auth from. REQUIRED. Confirm with the user first.'),
        frontendPath: z
          .string()
          .optional()
          .describe('Root folder for frontend apps. Default: ./frontend/apps'),
      },
      annotations: {
        title: 'Remove Embedded Frontend Auth',
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
      },
    },
    async ({ cwd, project, frontendPath }) => {
      const projectCwd = resolve(cwd);

      const probe = await execProcess('npx', ['restforge-designer', '--version'], {
        cwd: projectCwd,
        timeout: 10_000,
      });
      if (!probe.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the RESTForge Designer command-line tool could not be run via npx (the @restforgejs/platform package may not be installed in this folder).

Working directory: ${projectCwd}
Project: ${project}
Probe command: ${probe.command}
Exit code: ${probe.exitCode}

For the assistant:
- Make sure this project was created with 'npx create-restforge-app' (or the @restforgejs/platform package is installed in the project folder) before embedded auth can be removed, then try again.
- When explaining to the user, say something like "the RESTForge Designer tool couldn't run — make sure this project was created with create-restforge-app (or the RESTForge platform package is installed here), then try again". Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const args = ['auth', '--remove', `--project=${project}`, '--force'];
      if (frontendPath) args.push(`--frontend-path=${frontendPath}`);

      const result = await execProcess('npx', ['restforge-designer', ...args], {
        cwd: projectCwd,
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        const stderrBlock = result.stderr
          ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
          : '';
        return {
          content: [
            {
              type: 'text',
              text: `Failed to remove embedded auth.

Working directory: ${projectCwd}
Project: ${project}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- Tell the user the embedded auth was not removed; summarise the likely cause from the CLI output
  (e.g. project directory not found, binary error).
  Do not paste raw output unless asked. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      const stderrBlock = result.stderr
        ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
        : '';
      return {
        content: [
          {
            type: 'text',
            text: `Embedded auth removed.

Working directory: ${projectCwd}
Project: ${project}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---
${stderrBlock}
For the assistant:
- Summarise what was removed: files deleted, pages unguarded, marker removed.
  If auth was not installed (no-op), tell the user clearly.
  Do not paste raw output unless asked. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
