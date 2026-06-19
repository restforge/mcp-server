import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenListTables(server: McpServer): void {
  server.registerTool(
    'codegen_list_tables',
    {
      title: 'List Database Tables',
      description: `List all tables (and views) in the project's configured database, by wrapping restforge schema list. Live introspection — the CLI connects to the database and queries the catalog (information_schema in Postgres/MySQL, all_tables in Oracle).

USE WHEN:
- The user asks "what tables exist in the database?" or any equivalent question
- Pertanyaan dalam bentuk seperti "tabel apa saja yang ada di database", "list table di database project", "show me the tables", "ada tabel apa aja"
- Before authoring any SQL query (dashboard widget query, ad-hoc query, CRUD payload generation) and the table catalog is unknown — ground the query in the live database state instead of guessing
- The user mentions a specific table name and the AI is unsure whether it actually exists in the project's database
- The user is exploring an unfamiliar database before deciding what to build (e.g. picking a target table for a new endpoint or dashboard)
- The user asks to filter by schema or namespace (e.g. "list tables in core schema only", "tabel di schema public saja")
- The user asks for a read-only inspection without modifying anything
- Before invoking 'codegen_describe_table' — to discover candidate table names first

DO NOT USE FOR:
- Detailed column / primary key / foreign key / index information for a specific table -> use 'codegen_describe_table'
- Listing payload spec files on the filesystem (the payload/ folder) -> use generic Read or filesystem tools
- Validating whether a payload file is in sync with the database -> use 'codegen_validate_payload'
- Querying the actual row data inside tables -> out of scope; this tool returns only the table catalog (names + type), not row content
- Modifying the database schema (CREATE/ALTER/DROP TABLE) -> out of scope
- Listing schemas or databases themselves -> out of scope; this tool returns the tables WITHIN a schema, not the schemas themselves

This tool runs: npx restforge schema list --config=<config> --format=json [--schema=<schema>] [--include-system=<bool>] in the given cwd.
The CLI connects to the database described in the config file, queries the catalog, and emits a JSON envelope with summary counts and a tables array.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The config file (default 'db-connection.env') must exist in the project and contain valid database credentials. This tool does not pre-check that — if the CLI fails, the failure response will surface the underlying cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "list the database tables", "describe a specific table", "install the package").
- Speak in plain language. Summarise the result (database type and total table count); do not paste the raw JSON unless the user explicitly asks.
- This is a live introspection: the tool actively queries the database catalog (information_schema in Postgres/MySQL, all_tables in Oracle). The result reflects the database state at query time.
- Database type is auto-detected from the config file. The schema filter is dialect-aware (Postgres schema vs MySQL database vs Oracle owner) and uppercase is required for Oracle owners.
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
        schema: z
          .string()
          .min(1)
          .optional()
          .describe('Filter to a specific database schema/owner. Postgres: schema name (e.g. public); MySQL: database name; Oracle: owner (uppercase). When omitted, lists tables from all user-owned schemas.'),
        includeSystem: z
          .boolean()
          .optional()
          .describe("Default false. When true, include system tables (Postgres: pg_catalog, information_schema; MySQL: mysql, performance_schema, sys; Oracle: SYS, SYSTEM, etc). Most users do NOT want this."),
      },
      annotations: {
        title: 'List Database Tables',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, config, schema, includeSystem }) => {
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
Requested config: ${config}
Requested schema filter: ${schema ?? 'all user-owned schemas'}
Requested includeSystem: ${includeSystem ?? false}

For the assistant:
- The user needs to install the RESTForge package before the database table list can be retrieved.
- Suggest installing the package first, then retry listing the tables.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied. CLI defaults remain in
      // effect when the user does not specify them. per §3.5
      // --format=json is always sent: the CLI default is a human-readable table,
      // while this tool depends on JSON.parse of stdout.
      const cliArgs = [
        'restforge',
        'schema',
        'list',
        `--config=${config}`,
        '--format=json',
      ];
      if (schema !== undefined) cliArgs.push(`--schema=${schema}`);
      if (includeSystem !== undefined) cliArgs.push(`--include-system=${includeSystem}`);

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
              text: `Failed to list database tables.

Project path: ${projectCwd}
Config: ${config}
Schema filter: ${schema ?? 'all user-owned schemas'}
includeSystem: ${includeSystem ?? false}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that listing the database tables did not complete successfully.
- Summarise the most likely cause from the CLI output in plain language. Common causes:
  * Config file not found — suggest verifying the path and that the file exists in the project.
  * Database connection failed — suggest verifying the credentials, that the host is reachable, and that the port is open.
  * Unknown command 'schema list' — the installed RESTForge version may be older than this CLI subcommand; suggest upgrading the package.
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
              text: `Failed to parse the database table list as JSON.

Project path: ${projectCwd}
Config: ${config}
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
      const summary = (root.summary ?? {}) as Record<string, unknown>;
      const totalTables =
        typeof summary.totalTables === 'number' ? summary.totalTables : 'unknown';
      const databaseType =
        typeof summary.database === 'string' ? summary.database : 'unknown';
      const schemasInResult = Array.isArray(summary.schemas)
        ? `[${(summary.schemas as unknown[]).map((s) => JSON.stringify(s)).join(', ')}]`
        : 'unknown';

      const prettyJson = JSON.stringify(parsed, null, 2);

      // Branch B: success — one-line summary + labeled facts + fenced JSON output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Database tables retrieved successfully.

Project path: ${projectCwd}
Config: ${config}
Database: ${databaseType}
Schema filter: ${schema ?? 'all user-owned schemas'}
totalTables: ${totalTables}
schemas in result: ${schemasInResult}

--- Database Tables (JSON) ---
${prettyJson}
--- end Database Tables (JSON) ---

For the assistant:
- Confirm to the user that the table list was retrieved. Mention the database type and the total count in plain language.
- If a specific table was named in the user's question, find it in the list and confirm whether it exists; if not found, say so explicitly.
- Do not paste the full JSON unless the user asks. Summarise instead — for many tables, group by schema or list only the names relevant to the user's task.
- This is a read-only operation: it queries the database catalog tables (information_schema / pg_catalog / all_tables) without modifying anything.
- For deeper details on a specific table (columns, primary key, foreign keys, indexes), suggest the table-describe action as the next step. Do not mention internal tool names.
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
