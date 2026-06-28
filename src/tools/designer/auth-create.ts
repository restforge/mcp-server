import { z } from 'zod';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDesignerAuthCreate(server: McpServer): void {
  server.registerTool(
    'designer_auth_create',
    {
      title: 'Install Embedded Frontend Auth',
      description: `Install embedded auth (rfx_auth) into an existing RESTForge frontend project — writes
login.html, signup.html, js/rfx_auth.js, injects an auth guard into existing app pages,
and marks the project as having embedded auth in payload/app-config.json.

USE WHEN:
- The user wants to add a login/signup UI to an existing frontend project
- The user asks things like "pasang auth frontend", "install auth di frontend", "tambah login
  ke aplikasi", "add embedded auth", "install rfx_auth", "setup auth frontend"
- The frontend project was generated WITHOUT the vanilla-js-auth plugin and the user now
  wants to add auth capabilities
- The user explicitly wants the embedded rfx_auth approach (not the vanilla-js-auth plugin)

DO NOT USE FOR:
- Removing/uninstalling embedded auth -> use 'designer_auth_remove'
- Backend auth installation -> use 'project_auth'
- Projects that already use the vanilla-js-auth plugin (which has auth built in)
- Generating or re-generating frontend pages -> use 'designer_generate'

This tool wraps: npx restforge-designer auth --create --project=<project> [optional flags],
run in the given cwd.

What this command does (in order):
1. Renders login.html, signup.html, js/rfx_auth.js from embedded templates (no Google Sign-In)
2. Writes the 3 artifacts to <frontend-path>/<project>/
3. Injects an auth guard <script src="js/rfx_auth.js"> into all existing *.html pages in the
   target dir (except login.html and signup.html themselves)
4. Writes the embeddedAuth marker to payload/app-config.json (non-destructive; other keys untouched)

Idempotent: safe to re-run — files are skipped if they already exist, unless --overwrite is given.
If no app pages exist yet, the guard injection is skipped with a warning; the guard is injected
automatically when 'designer_generate' creates new pages later.

Preconditions:
- RESTForge Designer is invoked via 'npx restforge-designer' (the binary is bundled with the @restforgejs/platform package). This tool pre-checks
  that by running 'npx restforge-designer --version'; if it cannot run, the response surfaces
  a non-error precondition.

Note: Google Sign-In, the vanilla-js-auth plugin, and @restforgejs/auth (auth+RBAC) are out of
scope — this command only manages the rfx_auth embedded flow.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user.
- Summarise what was installed: which files were written and which pages got the auth guard.
- When a precondition is not met, frame it as a next-step suggestion.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the working directory where the binary is run'),
        project: z
          .string()
          .min(1)
          .describe('Frontend project name. Target app directory = <frontendPath>/<project>. REQUIRED.'),
        frontendPath: z
          .string()
          .optional()
          .describe('Root folder for frontend apps. Default: ./frontend/apps'),
        apiBaseUrl: z
          .string()
          .optional()
          .describe('API base URL (e.g. http://localhost:3032/api). If omitted, resolved from payload/app-config.json; fallback: http://127.0.0.1:3000/api/<project>'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Overwrite existing auth files (archive backup is created). Default: false'),
      },
      annotations: {
        title: 'Install Embedded Frontend Auth',
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
      },
    },
    async ({ cwd, project, frontendPath, apiBaseUrl, overwrite }) => {
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
- Make sure this project was created with 'npx create-restforge-app' (or the @restforgejs/platform package is installed in the project folder) before embedded auth can be installed, then try again.
- When explaining to the user, say something like "the RESTForge Designer tool couldn't run — make sure this project was created with create-restforge-app (or the RESTForge platform package is installed here), then try again". Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const args = ['auth', '--create', `--project=${project}`];
      if (frontendPath) args.push(`--frontend-path=${frontendPath}`);
      if (apiBaseUrl) args.push(`--api-base-url=${apiBaseUrl}`);
      if (overwrite) args.push('--overwrite');

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
              text: `Failed to install embedded auth.

Working directory: ${projectCwd}
Project: ${project}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- Tell the user the embedded auth was not installed; summarise the likely cause from the CLI output
  (e.g. project directory not found, files already exist and overwrite was not set).
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
            text: `Embedded auth installed.

Working directory: ${projectCwd}
Project: ${project}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---
${stderrBlock}
For the assistant:
- Summarise what was installed: auth files written, pages with guard injected, marker status.
  Do not paste raw output unless asked. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
