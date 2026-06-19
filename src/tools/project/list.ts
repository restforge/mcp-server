import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerProjectList(server: McpServer): void {
  server.registerTool(
    'project_list',
    {
      title: 'List Projects',
      description: `List the projects registered in the RESTForge registry (with endpoint count, database type, and creation date), by wrapping restforge project list.

USE WHEN:
- The user wants to see which projects exist, e.g. "lihat daftar project", "list project", "project apa saja yang ada"
- Before deleting a project, to confirm the exact project name

DO NOT USE FOR:
- Deleting a project -> use 'project_delete'
- Listing database tables -> use 'codegen_list_tables'

This tool runs: npx restforge project list in the given cwd (the verb takes no other flags).

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.

PRESENTATION GUIDANCE:
- Match the user's language. Never mention internal tool names; describe the action (e.g. "list the projects").
- Summarise the projects (names, endpoint counts, database types). Do not paste raw output unless the user explicitly asks.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform)'),
      },
      annotations: {
        title: 'List Projects',
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
- The user needs to install the RESTForge package before projects can be listed. Suggest installing it first, then retry. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const result = await execProcess('npx', ['restforge', 'project', 'list'], { cwd: projectCwd, timeout: 30_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to list projects.

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
- Tell the user the project list could not be retrieved; summarise the likely cause from the output. Do not paste raw output unless asked. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Projects listed.

Project path: ${projectCwd}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Read the output and summarise the registered projects (names, endpoint counts, database types, creation dates). Keep it concise. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
