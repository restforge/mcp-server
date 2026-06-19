import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerProjectDelete(server: McpServer): void {
  server.registerTool(
    'project_delete',
    {
      title: 'Delete Project',
      description: `Delete a project from the RESTForge registry, INCLUDING all of its endpoints, processors, dashboards, and consumers, by wrapping restforge project delete.

USE WHEN:
- The user explicitly wants to delete/remove an entire project, e.g. "hapus project", "delete project", "remove project beserta isinya"

DO NOT USE FOR:
- Listing projects -> use 'project_list'
- Deleting a single endpoint/processor/dashboard -> out of scope (this removes the WHOLE project)

This tool runs: npx restforge project delete --project=<project> --yes in the given cwd. '--yes' is always passed to skip the confirmation prompt (the prompt cannot be answered in this non-interactive context), so the deletion happens immediately.

IMPORTANT — this is highly destructive and not reversible here: it removes the entire project and every endpoint, processor, dashboard, and consumer inside it. There is NO additional in-tool confirmation. ALWAYS confirm the exact project name and intent with the user BEFORE calling this tool; consider listing projects first to verify the name.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The named project must exist in the registry. This tool does not pre-check it; the failure response surfaces the cause.

PRESENTATION GUIDANCE:
- Match the user's language. Never mention internal tool names; describe the action (e.g. "delete the project").
- Confirm what was deleted. Keep the reply concise.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform)'),
        project: z
          .string()
          .min(1)
          .describe('Name of the project to delete (and everything inside it). REQUIRED. Verify with the user first.'),
      },
      annotations: {
        title: 'Delete Project',
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
      },
    },
    async ({ cwd, project }) => {
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
- The user needs to install the RESTForge package before a project can be deleted. Suggest installing it first, then retry. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const result = await execProcess('npx', ['restforge', 'project', 'delete', `--project=${project}`, '--yes'], { cwd: projectCwd, timeout: 30_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to delete the project.

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
- Tell the user the project was not deleted; summarise the likely cause (e.g. the project name does not exist in the registry). Do not paste raw output unless asked. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project deleted.

Project path: ${projectCwd}
Project: ${project}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm the project and all its contents (endpoints, processors, dashboards, consumers) were removed. Keep the reply concise. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
