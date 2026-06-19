import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenDiffPayload(server: McpServer): void {
  server.registerTool(
    'codegen_diff_payload',
    {
      title: 'Diff Payload',
      description: `Show the column-level differences between existing payload spec files and the current database schema, by running restforge payload --diff.

USE WHEN:
- The user asks to see the detailed differences between a payload file and the current database schema (column-level)
- The user asks things like "tunjukkan diff payload", "apa yang berubah di table X", "kolom apa saja yang baru", "show schema diff", "what columns changed"
- After 'codegen_validate_payload' reported DRIFT and the user wants to know what specifically changed
- Pre-flight inspection before deciding whether to run sync
- Often called after 'codegen_validate_payload' once a DRIFT status is reported, to drill into the column-level differences for the affected file.

DO NOT USE FOR:
- Quick overall status (OK / DRIFT / ERROR per file) -> use 'codegen_validate_payload'
- Generating a payload from scratch for a table that has no payload yet -> use 'codegen_generate_payload'
- Applying the changes to payload files -> use 'codegen_sync_payload'

This tool runs: npx restforge payload diff --config=<config> [--table=<table>] in the given cwd.
The CLI reads existing payload JSON files from the project payload/ directory, connects to the database described
in the config file, and prints a per-column diff (added, removed, or type-changed columns) without
modifying any file. The CLI typically uses '[+]' for added columns, '[-]' for removed columns,
and '[~]' for type-changed columns.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The config file (default 'db-connection.env') must exist in the project and contain valid
  database credentials. This tool does not pre-check that — if the CLI fails, the failure response
  will surface the underlying cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "see the column-level differences", "do a quick overall validation", "sync the payload files").
- Speak in plain language. Summarise the result; do not paste raw CLI output unless the user explicitly asks.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform and the config file)'),
        config: z
          .string()
          .min(1)
          .default('db-connection.env')
          .describe('Config file name (relative to project) used by the CLI to connect to the database'),
        table: z
          .string()
          .min(1)
          .optional()
          .describe('Specific table name to inspect (e.g. supplier or core.supplier). When omitted, all payload files in the payload/ directory are diffed.'),
      },
      annotations: {
        title: 'Diff Payload',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, config, table }) => {
      const projectCwd = resolve(cwd);

      // Precondition check: @restforgejs/platform must be present in node_modules.
      // Treated as a non-error precondition per the authoring guide §3.4.
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
Requested table: ${table ?? 'all'}
Requested config: ${config}

For the assistant:
- The user needs to install the RESTForge package before column-level differences can be computed against the database schema.
- Use the appropriate package-installation tool to do this, then retry computing the differences.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied. Defaults inside restforge
      // (e.g. payload/ as the default output dir, all files when --table is omitted)
      // should remain in effect when the user does not specify them. per §3.5
      const args = ['restforge', 'payload', 'diff', `--config=${config}`];
      if (table) args.push(`--table=${table}`);

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 30_000 });

      // CLI failure: real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to diff payload.

Project path: ${projectCwd}
Config: ${config}
Table: ${table ?? 'all'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that computing the column-level differences did not complete successfully.
- Summarise the likely cause from the CLI output in plain language (common causes: the config file is missing or has incomplete credentials, the database is unreachable, the requested table does not exist, or the payload directory is empty). Do not paste the raw stdout/stderr unless the user explicitly asks.
- Offer to retry once the underlying issue is resolved. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Success: one-line summary + labeled facts + fenced raw output per §3.5.
      // The CLI prints column-level diff with [+], [-], [~] markers; the model
      // should translate those markers into plain language when talking to the user.
      return {
        content: [
          {
            type: 'text',
            text: `Payload diff completed.

Project path: ${projectCwd}
Config: ${config}
Table: ${table ?? 'all'}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Translate the diff markers into plain language for the user: '[+]' means a new column in the database that is not yet in the payload file, '[-]' means a column that exists in the payload file but has been removed from the database, and '[~]' means a column whose data type has changed.
- Group the differences per file or per table when multiple are reported, and name the affected columns explicitly so the user can decide what to do.
- If there are no differences, confirm in plain language that the payload files match the database.
- If the user wants to apply these changes, mention that the next step is to update the payload files automatically (with the previous version archived). Describe this step in plain language; do not name the internal tool.
- Keep the reply concise. Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
