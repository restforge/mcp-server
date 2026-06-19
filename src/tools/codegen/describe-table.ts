import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenDescribeTable(server: McpServer): void {
  server.registerTool(
    'codegen_describe_table',
    {
      title: 'Describe Database Table',
      description: `Describe a single database table — columns (with dialect-specific types), primary key, foreign keys, and indexes — by wrapping restforge schema describe. Live introspection — the CLI connects to the database and queries the catalog.

USE WHEN:
- The user asks about the columns, primary key, foreign keys, or indexes of a specific table
- Pertanyaan dalam bentuk seperti "kolom apa saja di tabel X", "describe tabel sales_order", "show schema for users table", "tabel X punya FK ke mana", "ada index apa di tabel Y"
- Before authoring a SQL JOIN — to discover the foreign key path between two tables and write the JOIN clause correctly
- Before authoring a dashboard widget query — to confirm column names and types before composing the SELECT
- The user wants to verify whether a specific column exists in a table
- The user asks "what type is column X in table Y" — column type is dialect-specific so live introspection is more reliable than guessing
- Before invoking 'codegen_create_dashboard' (with widget SQL) — to ground SQL identifiers in the live schema
- After 'codegen_list_tables' returned a candidate name and the user wants the per-column details

DO NOT USE FOR:
- Listing all tables in the database -> use 'codegen_list_tables'
- Querying the actual row data inside a table -> out of scope; this tool returns metadata (columns, PK, FK, indexes) only, not row content
- Validating a payload spec file against the database schema (file-level diff) -> use 'codegen_validate_payload' or 'codegen_diff_payload'
- Modifying the schema (ALTER TABLE) -> out of scope
- Inspecting the SQL definition behind a database view -> out of scope; only column-level info is returned for views
- Cross-database introspection (multiple databases at once) -> out of scope; a single config = a single connection

Cross-reference: this tool is the sibling of 'codegen_list_tables'. Use list-tables first to discover candidate names, then describe-table for the per-column details.

This tool runs: npx restforge schema describe --config=<config> --table=<table> [--include-foreign-keys=<bool>] [--include-indexes=<bool>] in the given cwd.
The CLI connects to the database described in the config file, queries the catalog, and emits a JSON envelope with the table metadata.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The config file (default 'db-connection.env') must exist in the project and contain valid database credentials. This tool does not pre-check that — if the CLI fails, the failure response will surface the underlying cause.
- The named table must exist in the database; otherwise the CLI fails with a "Table 'X' not found" error.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "describe the table", "list the database tables", "install the package").
- Speak in plain language. Summarise the result; do not paste the raw JSON unless the user explicitly asks.
- This is a live introspection: the tool actively queries the database catalog. The result reflects the schema state at query time.
- Column types are dialect-specific (Postgres: 'character varying(N)', MySQL: 'varchar(N)', Oracle: 'VARCHAR2(N)'). Use the type as-is when the user asks about column constraints; do not normalise.
- Foreign key 'references' field is the JOIN target — when the user asks "how do I join A and B", look at FK paths in both directions to compose the JOIN clause.
- When a precondition is not met (e.g. the package is not installed), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform and the config file)'),
        config: z
          .string()
          .min(1)
          .default('db-connection.env')
          .describe('Config file name relative to the project, used by the CLI to connect to the database'),
        table: z
          .string()
          .min(1)
          .describe('Table name to describe. Format: <schema>.<table> or just <table> (the CLI resolves the schema). Example: supplier, public.supplier, core.users.'),
        includeForeignKeys: z
          .boolean()
          .optional()
          .describe('Default true (CLI default). When false, omit the foreignKeys field from output.'),
        includeIndexes: z
          .boolean()
          .optional()
          .describe('Default true (CLI default). When false, omit the indexes field from output.'),
      },
      annotations: {
        title: 'Describe Database Table',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, config, table, includeForeignKeys, includeIndexes }) => {
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
Requested table: ${table}
Requested config: ${config}
Requested includeForeignKeys: ${includeForeignKeys ?? 'default (true)'}
Requested includeIndexes: ${includeIndexes ?? 'default (true)'}

For the assistant:
- The user needs to install the RESTForge package before the table description can be retrieved.
- Suggest installing the package first, then retry describing the table.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied. CLI defaults remain in
      // effect when the user does not specify them. per §3.5
      const cliArgs = [
        'restforge',
        'schema',
        'describe',
        `--config=${config}`,
        `--table=${table}`,
      ];
      if (includeForeignKeys !== undefined) cliArgs.push(`--include-foreign-keys=${includeForeignKeys}`);
      if (includeIndexes !== undefined) cliArgs.push(`--include-indexes=${includeIndexes}`);

      const result = await execProcess(
        'npx',
        cliArgs,
        {
          cwd: projectCwd,
          timeout: 30_000,
          env: { NODE_ENV: 'production' },
          stripFinalNewline: true,
        }
      );

      // Branch C: CLI failure — real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to describe the database table.

Project path: ${projectCwd}
Config: ${config}
Table: ${table}
includeForeignKeys: ${includeForeignKeys ?? 'default (true)'}
includeIndexes: ${includeIndexes ?? 'default (true)'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that describing the table did not complete successfully.
- Summarise the most likely cause from the CLI output in plain language. Common causes:
  * Table not found — the most common error. Suggest that the table name might be misspelled or that the user is looking in a different schema; offer to list the available tables first to find candidate names.
  * Config file not found — suggest verifying the path and that the file exists in the project.
  * Database connection failed — suggest verifying the credentials, that the host is reachable, and that the port is open.
  * Unknown command 'schema describe' — the installed RESTForge version may be older than this CLI subcommand; suggest upgrading the package.
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.
- Offer to retry once the underlying issue is resolved.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Branch D: JSON parse failure — real error per §3.4 (CLI succeeded but produced invalid output).
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to parse the table description as JSON.

Project path: ${projectCwd}
Config: ${config}
Table: ${table}
Reason: ${msg}

--- Raw stdout ---
${result.stdout}
--- end Raw stdout ---

For the assistant:
- The CLI returned output that is not valid JSON.
- Summarise this to the user in plain language; do not paste the raw stdout unless they explicitly ask.
- Suggest checking that the installed RESTForge package version is compatible. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Defensive labeled facts: if the JSON shape changes upstream, fall back to 'unknown' / 'n/a'
      // rather than crashing. Mirror the catalog tools pattern.
      const root = (parsed ?? {}) as Record<string, unknown>;
      const tableObj = (root.table ?? {}) as Record<string, unknown>;
      const tableSchema = typeof tableObj.schema === 'string' ? tableObj.schema : 'unknown';
      const tableName = typeof tableObj.name === 'string' ? tableObj.name : 'unknown';
      const tableType = typeof tableObj.type === 'string' ? tableObj.type : 'unknown';
      const databaseType = typeof root.database === 'string' ? root.database : 'unknown';

      const columns = Array.isArray(root.columns) ? (root.columns as unknown[]) : [];
      const columnsCount = columns.length;

      const pk = root.primaryKey;
      let primaryKeyLabel: string;
      if (pk && typeof pk === 'object' && Array.isArray((pk as Record<string, unknown>).columns)) {
        const pkCols = (pk as Record<string, unknown>).columns as unknown[];
        primaryKeyLabel = `[${pkCols.map((c) => JSON.stringify(c)).join(', ')}]`;
      } else if (pk === null) {
        primaryKeyLabel = 'none';
      } else {
        primaryKeyLabel = 'unknown';
      }

      const foreignKeysCount =
        includeForeignKeys === false
          ? 'n/a (excluded)'
          : Array.isArray(root.foreignKeys)
            ? (root.foreignKeys as unknown[]).length
            : 'unknown';
      const indexesCount =
        includeIndexes === false
          ? 'n/a (excluded)'
          : Array.isArray(root.indexes)
            ? (root.indexes as unknown[]).length
            : 'unknown';

      const prettyJson = JSON.stringify(parsed, null, 2);

      // Branch B: success — one-line summary + labeled facts + fenced JSON output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Table description retrieved successfully.

Project path: ${projectCwd}
Config: ${config}
Database: ${databaseType}
Table: ${tableSchema}.${tableName} (${tableType})
columnsCount: ${columnsCount}
primaryKey: ${primaryKeyLabel}
foreignKeysCount: ${foreignKeysCount}
indexesCount: ${indexesCount}

--- Table Description (JSON) ---
${prettyJson}
--- end Table Description (JSON) ---

For the assistant:
- Confirm to the user that the table description was retrieved. Mention the table name and column count in plain language.
- When the user asked to compose a SQL query (e.g. for a dashboard widget), use this metadata as ground truth for: (1) column names and types — match SQL identifiers exactly; (2) primary key — for JOIN target identity; (3) foreign keys — for cross-table JOIN paths; (4) indexes — informational, helps anticipate query performance.
- Column types are dialect-specific (e.g. 'character varying(50)' in Postgres, 'varchar(50)' in MySQL, 'VARCHAR2(50)' in Oracle). Use the type as-is when the user asks about column constraints; do not normalise.
- Foreign keys describe the schema-level relationship (which column references which target). Use the 'references' field to write JOIN clauses correctly.
- This is a read-only operation: it queries the database catalog without modifying anything.
- Do not paste the full JSON unless the user asks. Summarise — for a wide table (more than 10 columns), list only the columns relevant to the user's task.
- For listing all tables in the database, suggest the table-list action. Do not mention internal tool names.
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
