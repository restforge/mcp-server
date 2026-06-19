import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenValidatePayload(server: McpServer): void {
  server.registerTool(
    'codegen_validate_payload',
    {
      title: 'Validate Payload',
      description: `Validate that existing payload spec files in a project are still in sync with the current database schema, by running restforge payload --validate.

USE WHEN:
- The user asks to validate, check, or verify whether existing payload files are still in sync with the current database schema
- The user asks things like "cek drift payload", "validate semua payload", "apakah payload masih sinkron", "is the schema in sync", "check schema drift"
- The user mentions ALTER TABLE in the database and wants to know which payloads are affected
- Routine drift check after pulling new database migrations
- Periodic audit of payload files in a project
- Often called before 'codegen_diff_payload' as a quick overall status pass; if a file shows DRIFT, follow up with 'codegen_diff_payload' to see column-level details.
- The user wants to validate PAYLOAD FILES against the database schema, not configuration credentials

DO NOT USE FOR:
- Seeing the per-column detail of what changed -> use 'codegen_diff_payload'
- Generating a payload from scratch for a table that has no payload yet -> use 'codegen_generate_payload'
- Updating payload files to match the database -> use 'codegen_sync_payload'
- Checking the database connection, license, or other config credentials -> use 'setup_validate_config'

This tool runs: npx restforge payload validate --config=<config> [--table=<table>] in the given cwd.
The CLI reads existing payload JSON files from the project payload/ directory, connects to the database described
in the config file, and reports per-file status (typically OK / DRIFT / ERROR) without modifying any file.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The config file (default 'db-connection.env') must exist in the project and contain valid
  database credentials. This tool does not pre-check that — if the CLI fails, the failure response
  will surface the underlying cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "validate the payload files", "see the column-level differences", "sync the payload files").
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
          .describe('Specific table name to check (e.g. supplier or core.supplier). When omitted, all payload files in the payload/ directory are checked.'),
      },
      annotations: {
        title: 'Validate Payload',
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
- The user needs to install the RESTForge package before payload files can be validated against the database schema.
- Use the appropriate package-installation tool to do this, then retry validating the payload.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied. Defaults inside restforge
      // (e.g. payload/ as the default output dir, all files when --table is omitted)
      // should remain in effect when the user does not specify them. per §3.5
      const args = ['restforge', 'payload', 'validate', `--config=${config}`];
      if (table) args.push(`--table=${table}`);

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 30_000 });

      // CLI failure: real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to validate payload.

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
- Tell the user that the payload validation did not complete successfully.
- Summarise the likely cause from the CLI output in plain language (common causes: the config file is missing or has incomplete credentials, the database is unreachable, the requested table does not exist, or the payload directory is empty). Do not paste the raw stdout/stderr unless the user explicitly asks.
- Offer to retry once the underlying issue is resolved. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Success: one-line summary + labeled facts + fenced raw output per §3.5.
      // The CLI prints a Summary section with counts (OK / DRIFT / ERROR); the
      // model should extract those numbers from stdout when talking to the user.
      return {
        content: [
          {
            type: 'text',
            text: `Payload validation completed.

Project path: ${projectCwd}
Config: ${config}
Table: ${table ?? 'all'}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Read the Summary section in the CLI output above and tell the user how many payload files are OK, in DRIFT, or in ERROR.
- If every file is OK, confirm in plain language that the payload files are still in sync with the database.
- If any file is in DRIFT or ERROR, suggest as the next step that the user can see the column-level differences for the affected file (added, removed, or changed columns). Do not name the internal tool — describe it by what it does.
- If the user later wants to apply those changes, mention that the next step is to update the payload files automatically (with the previous version archived). Describe this step in plain language; do not name the internal tool.
- Keep the reply concise. Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
