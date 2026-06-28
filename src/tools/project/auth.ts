import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerProjectAuth(server: McpServer): void {
  server.registerTool(
    'project_auth',
    {
      title: 'Install Auth Extension',
      description: `Install the auth extension (SDF, DB tables, middleware, router, 6 processors, env vars,
and runtime dependencies) into an existing RESTForge project, by running
npx restforge project auth --create.

USE WHEN:
- The user wants to add authentication to an existing RESTForge project
- The user asks things like "pasang auth", "install auth extension", "tambah auth ke project",
  "add authentication", "setup auth untuk project"
- The project already exists (created via endpoint create or fast-track)

DO NOT USE FOR:
- Creating a new project from scratch -> use the setup_* and codegen_* tools first
- Frontend auth (embedded login UI) -> use 'designer_auth_create'
- Listing projects -> use 'project_list'

This tool wraps: npx restforge project auth --create --project=<project> [optional flags],
run in the given cwd. The --create flag is always passed (it is the required trigger for
the CLI command). Optional flags (schemaPath, config, force) are forwarded only when supplied.

What this command does (in order):
1. Generates auth SDF files (prefix rfx) to --schema-path
2. Creates auth tables in DB via dbschema-kit (idempotent, IF NOT EXISTS)
3. Writes auth middleware + router
4. Writes 6 processors: register, login, refresh, logout, me, reset-password
5. Injects auth env vars (random JWT_SECRET) into the config file
6. Records bcrypt + jsonwebtoken as runtime dependencies

Preconditions:
- The project folder must have @restforgejs/platform installed in node_modules.
  This tool pre-checks that; if the package is missing, the response surfaces a non-error precondition.
- The target project must already exist in the RESTForge registry (src/modules/<name>.js
  or recorded via project create). This tool does NOT pre-check project existence;
  the CLI error response surfaces the cause.
- The database must be active and reachable with the credentials in the config file.

Note: Google Sign-In, RBAC, and Designer frontend integration are out of scope for this command.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user.
- Summarise what was installed (SDF files generated, tables created, processors written).
- When a precondition is not met, frame it as a question or next-step suggestion.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the RESTForge project folder (must contain node_modules/@restforgejs/platform)'),
        project: z
          .string()
          .min(1)
          .describe('Name of the existing RESTForge project to install auth into. REQUIRED.'),
        schemaPath: z
          .string()
          .optional()
          .describe('Folder for auth SDF output files. Default: ./schema'),
        config: z
          .string()
          .optional()
          .describe('DB config file path. Default: config/db-connection.env'),
        force: z
          .boolean()
          .optional()
          .describe('Overwrite existing auth files (backup is still created). Default: false'),
      },
      annotations: {
        title: 'Install Auth Extension',
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
      },
    },
    async ({ cwd, project, schemaPath, config, force }) => {
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
- The user needs to install the RESTForge package before auth can be installed. Suggest installing it first, then retry. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const args = ['restforge', 'project', 'auth', '--create', `--project=${project}`];
      if (schemaPath) args.push(`--schema-path=${schemaPath}`);
      if (config) args.push(`--config=${config}`);
      if (force === true) args.push('--force');

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 60_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to install auth extension.

Project path: ${projectCwd}
Project: ${project}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user the auth extension was not installed; summarise the likely cause from the
  CLI output (e.g. project does not exist, DB not reachable, config file missing).
  Do not paste raw output unless asked. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Auth extension installed.

Project path: ${projectCwd}
Project: ${project}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Summarise what was installed: SDF files generated, DB tables created, middleware, router, processors, env vars.
  Do not paste raw output unless the user asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
