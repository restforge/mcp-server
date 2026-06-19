import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

function truncateSql(sql: string): string {
  return sql.length > 100 ? `${sql.substring(0, 100)}...` : sql;
}

export function registerCodegenValidateSql(server: McpServer): void {
  server.registerTool(
    'codegen_validate_sql',
    {
      title: 'Validate SQL Query',
      description: `Validate a SELECT (or WITH/CTE) SQL statement against the live database — checks syntax, column references, function existence, type compatibility, and JOIN resolution — by wrapping restforge query:validate. Live introspection — the CLI runs EXPLAIN against the configured database without executing any rows.

USE WHEN:
- The user asks "is this SQL valid?", "check my SQL", "validate this query", "cek SQL ini bener atau salah"
- Before invoking 'codegen_create_dashboard' with widget queries — to verify each widget SQL passes against the live database before committing the payload file
- After authoring a complex SQL (multi-table JOIN, CTE, window function) — to catch column reference errors, ambiguous columns, dialect-specific function mismatches before runtime
- The user reports a dashboard widget failed at runtime with a database error — to confirm whether the SQL is the cause and identify the specific error code/message
- Iterating on SQL: validate, fix, re-validate (the tool is idempotent and read-only)
- After 'codegen_describe_table' suggested column names but the user wants a final correctness check on a draft SQL

DO NOT USE FOR:
- Validating the JSON shape of a payload file -> use 'codegen_validate_payload' or 'codegen_validate_dashboard_payload'
- Checking whether the SQL result shape matches a widget query key's expected shape (scalar/object/array) -> out of scope; that is checked by the dashboard payload validator separately
- Running INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE — these statements are rejected before any database connection is opened (this tool is read-only)
- Listing tables in the database -> use 'codegen_list_tables'
- Describing a table's columns/PK/FK -> use 'codegen_describe_table'
- Performance/query plan analysis -> out of scope; the tool only reports validation pass/fail, not the query plan

Cross-reference: this tool complements 'codegen_list_tables' and 'codegen_describe_table'. Use list/describe to ground SQL on the live schema, then validate-sql to confirm the composed SQL is correct before commit.

This tool runs: npx restforge query:validate --config=<config> --sql=<sql> --pretty=false in the given cwd.
The CLI runs EXPLAIN (PostgreSQL/MySQL) or EXPLAIN PLAN FOR (Oracle) against the configured database, without executing any rows.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules (>= 2.4.8 for query:validate support).
- The config file (default 'db-connection.env') must exist in the project (or in cwd/config/) and contain valid database credentials. The CLI auto-fallbacks to the config/ subfolder if the file is not found at the top level.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "validate the SQL", "list the database tables").
- Speak in plain language. For success: confirm the SQL is valid in one sentence. For failure: summarise the error category in plain language (e.g. "the column 'x' doesn't exist in this table"), and suggest the next action (revise SQL based on error, re-validate).
- This is a live introspection: the tool actively runs EXPLAIN against the database. The result reflects the database state at query time. Zero rows are executed; the planner only parses and resolves references.
- For SELECT-only rejection (when the SQL starts with INSERT/UPDATE/DELETE/etc), explain that the validator is read-only by design and ask the user to revise to a SELECT statement.
- Error codes are dialect-specific: Postgres uses 5-char SQLSTATE (e.g. '42703'), MySQL uses ER_* names or numeric errno, Oracle uses 'ORA-XXXXX'. When relevant, mention the category in plain language (column not found, ambiguous reference, function mismatch, etc) instead of citing the raw code.
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
        sql: z
          .string()
          .min(1)
          .describe('SQL string to validate. Must be a SELECT or WITH (CTE) statement. Other statements (INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE) are rejected before any database connection is opened.'),
      },
      annotations: {
        title: 'Validate SQL Query',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, config, sql }) => {
      const projectCwd = resolve(cwd);
      const sqlPreview = truncateSql(sql);

      // Branch A: Precondition check — @restforgejs/platform must be present in node_modules.
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
Requested sql (first 100 chars): ${sqlPreview}

For the assistant:
- The user needs to install the RESTForge package before SQL validation can run.
- Suggest installing the package first, then retry validating the SQL.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      // Run CLI with --pretty=false (compact); the MCP layer re-formats JSON for output.
      const cliArgs = [
        'restforge',
        'query:validate',
        `--config=${config}`,
        `--sql=${sql}`,
        '--pretty=false',
      ];

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

      // Branch D: SELECT-only rejection — non-error guidance per Q6.
      // Detected via stderr substring (CLI exits 1 with stable error prefix).
      if (!result.success && result.stderr.includes('Only SELECT or WITH')) {
        return {
          content: [
            {
              type: 'text',
              text: `SQL was rejected before validation: only SELECT or WITH (CTE) statements are allowed.

Project path: ${projectCwd}
Config: ${config}
Submitted SQL (first 100 chars): ${sqlPreview}

For the assistant:
- The validator only accepts read-only SELECT or WITH statements. Statements like INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE are rejected before any database connection is opened.
- This is a guardrail to prevent accidental data mutation during validation.
- Tell the user that the SQL is not a SELECT/WITH statement. Suggest revising to a SELECT statement and retry.
- If the user actually intended to run a non-SELECT statement (e.g. data migration), this validator is the wrong tool — they should run the SQL directly via their database client. Do not attempt to bypass this check.
- Match the user's language. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      // Branch E: Other CLI failure — real error per §3.4.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to validate the SQL.

Project path: ${projectCwd}
Config: ${config}
Submitted SQL (first 100 chars): ${sqlPreview}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that SQL validation did not complete successfully.
- Summarise the most likely cause from the CLI output in plain language. Common causes:
  * Config file not found — suggest verifying the path and that the file exists in the project (or in cwd/config/).
  * Database connection failed — suggest verifying the credentials, that the host is reachable, and that the port is open.
  * Unknown command 'query:validate' — the installed RESTForge version may be older than this CLI subcommand; suggest upgrading the package (requires @restforgejs/platform >= 2.4.8).
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.
- Offer to retry once the underlying issue is resolved.`,
            },
          ],
          isError: true,
        };
      }

      // Branch F: JSON parse failure — real error per §3.4 (CLI succeeded but produced invalid output).
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to parse the SQL validation result as JSON.

Project path: ${projectCwd}
Config: ${config}
Reason: ${msg}

--- Raw stdout ---
${result.stdout}
--- end Raw stdout ---

For the assistant:
- The CLI returned output that is not valid JSON.
- Summarise this to the user in plain language; do not paste the raw stdout unless they explicitly ask.
- Suggest checking that the installed RESTForge package version is compatible (requires @restforgejs/platform >= 2.4.8). Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      // Defensive labeled facts: if the JSON shape changes upstream, fall back to 'unknown' / 'n/a'
      // rather than crashing. Mirror the catalog tools pattern.
      const root = (parsed ?? {}) as Record<string, unknown>;
      const ok = root.ok === true;
      const databaseType = typeof root.database === 'string' ? root.database : 'unknown';
      const errorObj = (root.error ?? {}) as Record<string, unknown>;
      const errorCode = typeof errorObj.code === 'string' ? errorObj.code : 'n/a';
      const errorMessage = typeof errorObj.message === 'string' ? errorObj.message : 'n/a';
      const errorHint = typeof errorObj.hint === 'string' ? errorObj.hint : 'n/a';

      const prettyJson = JSON.stringify(parsed, null, 2);

      // Branch B: success — SQL valid (ok: true).
      if (ok) {
        return {
          content: [
            {
              type: 'text',
              text: `SQL validation succeeded — the statement is syntactically and semantically valid against the live database schema.

Project path: ${projectCwd}
Config: ${config}
Database: ${databaseType}
ok: true

--- Validation Result (JSON) ---
${prettyJson}
--- end Validation Result (JSON) ---

For the assistant:
- Confirm to the user that the SQL is valid. Mention the database type in plain language.
- This is a read-only operation: it ran EXPLAIN against the database without executing the query (zero rows touched).
- The validation only checks: syntax, column references, function existence, type compatibility, JOIN resolution. It does NOT check business semantics (e.g. whether the result shape matches a widget query key's expected shape — that is checked by the dashboard payload validator separately).
- Match the user's language.`,
            },
          ],
        };
      }

      // Branch C: success — SQL invalid (ok: false). Tool ran successfully; negative validation result is normal.
      return {
        content: [
          {
            type: 'text',
            text: `SQL validation reported an error — the statement is not valid against the live database schema.

Project path: ${projectCwd}
Config: ${config}
Database: ${databaseType}
ok: false
errorCode: ${errorCode}
errorMessage: ${errorMessage}
errorHint: ${errorHint}

--- Validation Result (JSON) ---
${prettyJson}
--- end Validation Result (JSON) ---

For the assistant:
- Tell the user that the SQL did not pass validation. Summarise the error in plain language.
- Common error categories (Postgres SQLSTATE prefix):
  * 42703 (undefined_column) — a referenced column does not exist; suggest using the table-describe action to verify column names
  * 42702 (ambiguous_column) — column reference is ambiguous between multiple tables; suggest qualifying with table alias
  * 42883 (undefined_function) — function does not exist or argument types do not match; check dialect-specific function names
  * 42P01 (undefined_table) — referenced table does not exist; suggest using the table-list action
  * 42601 (syntax_error) — SQL syntax issue
- For MySQL/Oracle, error.code uses different conventions (MySQL ER_*/errno, Oracle ORA-XXXXX).
- Do not paste the raw JSON unless the user explicitly asks. Do not mention internal tool names.
- Suggest revising the SQL based on the error and re-validating.
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
