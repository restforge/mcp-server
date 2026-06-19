import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDataPull(server: McpServer): void {
  server.registerTool(
    'data_pull',
    {
      title: 'Pull Table Data to Envelope Files',
      description: `Export rows from database tables into JSON envelope files (data-storage/<table>.json), driven purely by SDF metadata, by wrapping restforge data pull. Exports one table (--table), a schema or comma-separated schemas (--schema), or every registered table (--all-schemas). Only tables registered in the SDF can be pulled.

USE WHEN:
- The user wants to export, dump, snapshot, or back up table rows to files, e.g. "export data tabel", "pull data", "dump rows ke file", "snapshot data tabel"
- The user wants to move data between databases (pull from source, then 'data_push' into target) — pull is the first half
- The user wants a dialect-agnostic export based on the SDF (not raw DB introspection)

DO NOT USE FOR:
- Loading/importing rows INTO a database -> use 'data_push'
- Generating or reading the table SCHEMA (DDL/structure) -> use the dbschema tools
- Reading the live database connection config -> use 'setup_read_env'

This tool runs: npx restforge data pull (--table | --schema | --all-schemas) [--config] [--schema-path] [--limit] [--batch-size] [--storage-path] [--force] --json in the given cwd. The --json flag is always passed so the summary is machine-readable.

Scope (exactly ONE required): provide exactly one of 'table', 'schema', or 'allSchemas'. Supplying none or more than one is a usage error.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The SDF (schema files) and a database config must be resolvable. Without --config, a default config must be set. This tool does not pre-check these — if the CLI fails, the failure response surfaces the cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "export the table data", "load the data into the target database").
- The CLI prints a JSON summary; read it and tell the user how many rows/tables were exported and where the files were written. Do not paste the raw JSON unless the user explicitly asks.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform; SDF + data-storage resolved from here)'),
        table: z
          .string()
          .min(1)
          .optional()
          .describe('Source table name (must be registered in SDF). Use schema.table for schema-qualified tables. Exactly one of table/schema/allSchemas.'),
        schema: z
          .string()
          .min(1)
          .optional()
          .describe('Schema filter: one name or comma-separated (e.g. public,sales). Pulls all SDF tables in those schemas. Exactly one of table/schema/allSchemas.'),
        allSchemas: z
          .boolean()
          .optional()
          .describe('Pull every table registered in the SDF across all schemas. Exactly one of table/schema/allSchemas.'),
        config: z
          .string()
          .min(1)
          .optional()
          .describe('Database config file (.env). When omitted, the CLI falls back to the default config.'),
        schemaPath: z
          .string()
          .min(1)
          .optional()
          .describe('SDF location (file or folder). When omitted, the CLI uses its default (schema).'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum total rows to export (applied per table for schema/allSchemas). When omitted, all rows are exported.'),
        batchSize: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Internal read batch size. When omitted, the CLI uses its default (1000).'),
        storagePath: z
          .string()
          .min(1)
          .optional()
          .describe('Output folder relative to cwd. When omitted, the CLI uses its default (data-storage).'),
        force: z
          .boolean()
          .optional()
          .describe('Overwrite output files if they already exist. Without it, an existing output file aborts the pull.'),
      },
      annotations: {
        title: 'Pull Table Data to Envelope Files',
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
      },
    },
    async ({ cwd, table, schema, allSchemas, config, schemaPath, limit, batchSize, storagePath, force }) => {
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
- The user needs to install the RESTForge package before table data can be exported.
- Suggest installing the package first, then retry. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      // Scope is mutually exclusive: exactly one of table / schema / allSchemas.
      const scopeCount = [table, schema, allSchemas ? true : undefined].filter((v) => v !== undefined).length;
      if (scopeCount !== 1) {
        return {
          content: [
            {
              type: 'text',
              text: `Scope not specified correctly: provide exactly one of 'table', 'schema', or 'allSchemas' (got ${scopeCount}).

For the assistant:
- Ask the user which scope they want: a single table, one/more schemas, or every registered table. Then retry with exactly one scope set.`,
            },
          ],
          isError: false,
        };
      }

      const args = ['restforge', 'data', 'pull'];
      if (table) args.push(`--table=${table}`);
      if (schema) args.push(`--schema=${schema}`);
      if (allSchemas) args.push('--all-schemas');
      if (config) args.push(`--config=${config}`);
      if (schemaPath) args.push(`--schema-path=${schemaPath}`);
      if (limit !== undefined) args.push(`--limit=${limit}`);
      if (batchSize !== undefined) args.push(`--batch-size=${batchSize}`);
      if (storagePath) args.push(`--storage-path=${storagePath}`);
      if (force) args.push('--force');
      args.push('--json');

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 120_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to pull table data.

Project path: ${projectCwd}
Scope: ${table ? `table=${table}` : schema ? `schema=${schema}` : 'all-schemas'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user the data export did not complete.
- Summarise the likely cause from the CLI output. Common causes by exit code: 1 = an output file already exists (suggest force) or the SDF could not be read; 2 = usage problem (config required but no default, table not registered/ambiguous, schema matched no tables); 3 = database connection or query error.
- Do not paste raw output unless the user asks. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Table data exported.

Project path: ${projectCwd}
Scope: ${table ? `table=${table}` : schema ? `schema=${schema}` : 'all-schemas'}
Command: ${result.command}

--- CLI output (JSON summary) ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Read the JSON summary above and tell the user how many rows/tables were exported and the output file path(s) (under the storage folder, schema-qualified tables nested under their schema subfolder).
- If the user's goal is to move data into another database, the next step is to load these files into the target. Describe it by what it does; do not name internal tools.
- Keep the reply concise. Do not paste the raw JSON unless the user explicitly asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
