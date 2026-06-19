import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDataPush(server: McpServer): void {
  server.registerTool(
    'data_push',
    {
      title: 'Push Envelope Files into Database',
      description: `Load rows from JSON envelope files (data-storage/<table>.json) INTO target database tables via batch INSERT, driven purely by SDF metadata, by wrapping restforge data push. This is APPEND-ONLY (no upsert/replace). Loads one table (--table), a schema or comma-separated schemas (--schema), or every table that has a file (--all-schemas). File names match 'data_pull' exactly, so pulled files can be pushed directly.

USE WHEN:
- The user wants to import, load, seed, or restore table rows from envelope files into a database, e.g. "push data", "import data ke database", "load rows dari file", "seed data tabel"
- The user is moving data between databases and has already exported files with 'data_pull' — push is the second half
- The user wants a dialect-agnostic import based on the SDF

DO NOT USE FOR:
- Exporting rows OUT of a database to files -> use 'data_pull'
- Updating or replacing existing rows -> not supported; this is append-only INSERT and will add duplicate rows if run again
- Creating the table SCHEMA itself -> use the dbschema tools

This tool runs: npx restforge data push (--table | --schema | --all-schemas) [--config] [--schema-path] [--storage-path] [--batch-size] --json in the given cwd. The --json flag is always passed so the summary is machine-readable. There is intentionally NO force/overwrite/upsert option — the verb only appends.

Scope (exactly ONE required): provide exactly one of 'table', 'schema', or 'allSchemas'. For schema/allSchemas, tables are loaded in topological FK order (parent before child).

IMPORTANT — this MUTATES the target database (inserts rows). Because it is append-only, running it twice inserts the data twice. Confirm with the user before pushing into a database that may already contain the rows.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The envelope files must exist under the storage folder, and a database config must be resolvable. This tool does not pre-check these — if the CLI fails, the failure response surfaces the cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "load the data into the database").
- The CLI prints a JSON summary; read it and tell the user how many rows/tables were inserted. Do not paste the raw JSON unless the user explicitly asks.
- Because the import is append-only, remind the user that re-running adds duplicate rows.
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
          .describe('Target table name (must be registered in SDF). Use schema.table for schema-qualified tables. Exactly one of table/schema/allSchemas.'),
        schema: z
          .string()
          .min(1)
          .optional()
          .describe('Schema filter: one name or comma-separated (e.g. public,sales). Pushes SDF tables in those schemas that have a file, in FK parent->child order. Exactly one of table/schema/allSchemas.'),
        allSchemas: z
          .boolean()
          .optional()
          .describe('Push every SDF table that has a file under storage, across all schemas, in FK parent->child order. Exactly one of table/schema/allSchemas.'),
        config: z
          .string()
          .min(1)
          .optional()
          .describe('Target database config file (.env). When omitted, the CLI falls back to the default config.'),
        schemaPath: z
          .string()
          .min(1)
          .optional()
          .describe('SDF location (file or folder). When omitted, the CLI uses its default (schema).'),
        storagePath: z
          .string()
          .min(1)
          .optional()
          .describe('Source folder for envelope files, relative to cwd. When omitted, the CLI uses its default (data-storage).'),
        batchSize: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('INSERT batch size (also the commit unit). When omitted, the CLI uses its default (1000).'),
      },
      annotations: {
        title: 'Push Envelope Files into Database',
        readOnlyHint: false,
        idempotentHint: false, // append-only: re-running duplicates rows
        destructiveHint: true, // mutates the target database
      },
    },
    async ({ cwd, table, schema, allSchemas, config, schemaPath, storagePath, batchSize }) => {
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
- The user needs to install the RESTForge package before envelope files can be loaded into a database.
- Suggest installing the package first, then retry. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const scopeCount = [table, schema, allSchemas ? true : undefined].filter((v) => v !== undefined).length;
      if (scopeCount !== 1) {
        return {
          content: [
            {
              type: 'text',
              text: `Scope not specified correctly: provide exactly one of 'table', 'schema', or 'allSchemas' (got ${scopeCount}).

For the assistant:
- Ask the user which scope they want: a single table, one/more schemas, or every table with a file. Then retry with exactly one scope set.`,
            },
          ],
          isError: false,
        };
      }

      const args = ['restforge', 'data', 'push'];
      if (table) args.push(`--table=${table}`);
      if (schema) args.push(`--schema=${schema}`);
      if (allSchemas) args.push('--all-schemas');
      if (config) args.push(`--config=${config}`);
      if (schemaPath) args.push(`--schema-path=${schemaPath}`);
      if (storagePath) args.push(`--storage-path=${storagePath}`);
      if (batchSize !== undefined) args.push(`--batch-size=${batchSize}`);
      args.push('--json');

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 120_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to push data into the database.

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
- Tell the user the data import did not complete. Note that, because import is append-only and commits per batch, some early batches/tables may already be inserted.
- Summarise the likely cause from the CLI output. Common causes by exit code: 1 = the envelope file is missing or its shape/columns do not match the SDF; 2 = usage problem (config required but no default, table not registered, schema matched no tables); 3 = database connection or INSERT error.
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
            text: `Data loaded into the database (append-only INSERT).

Project path: ${projectCwd}
Scope: ${table ? `table=${table}` : schema ? `schema=${schema}` : 'all-schemas'}
Command: ${result.command}

--- CLI output (JSON summary) ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Read the JSON summary above and tell the user how many rows/tables were inserted.
- Remind the user this was append-only: running it again would insert the same rows a second time.
- Keep the reply concise. Do not paste the raw JSON unless the user explicitly asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
