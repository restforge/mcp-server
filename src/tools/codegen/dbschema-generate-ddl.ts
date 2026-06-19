import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenDbschemaGenerateDdl(server: McpServer): void {
  server.registerTool(
    'codegen_dbschema_generate_ddl',
    {
      title: 'Generate DDL from dbschema-kit Files',
      description: `Generate dialect-specific DDL SQL (CREATE TABLE, CREATE INDEX, optional DROP TABLE) from dbschema-kit definition files in topological order, by wrapping restforge schema generate-ddl. Output goes to stdout (returned in the response) or to a file when 'output' is set. Tables are emitted in topological order so parent tables are created before children; DROP order is reversed.

USE WHEN:
- The user asks to generate DDL, "buatkan SQL DDL", "generate CREATE TABLE statements"
- Pertanyaan dalam bentuk: "convert schema ke postgres SQL", "generate DDL untuk MySQL", "buatkan migration script"
- Before applying schema to a database — for preview/review (safer than running migrate directly)
- The user wants a portable SQL file for sharing with a DBA or for git versioning
- The user asks for cross-dialect compatibility ("apakah schema bisa untuk postgres dan mysql")
- Migration script preparation
- After validating schema and the user wants to see the SQL output

DO NOT USE FOR:
- Applying DDL to a live database -> use 'codegen_dbschema_migrate'
- Generating CRUD payload SQL -> out of scope (different layer)
- Generating ad-hoc query SQL -> out of scope
- Generating DDL for tables not defined in schema files -> out of scope (only schema-as-code files are processed)
- Validating schema correctness -> use 'codegen_dbschema_validate'

This tool runs: npx restforge schema generate-ddl --schema-path=<path> --dialect=<X> [--output=<file>] [--drop=<bool>] in the given cwd.

SOFT-DELETE EMISSION: a table declared with softDelete enabled emits a consistency CHECK constraint named chk_<table>_soft_delete_consistency and emits its non-unique indexes as PostgreSQL partial indexes (WHERE is_deleted = FALSE); UNIQUE constraints are never made partial. Soft-delete is PostgreSQL-only in Phase 1: generating DDL for any other dialect fails with a clear error ("soft-delete is PostgreSQL-only in Phase 1") instead of emitting wrong DDL silently.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The schema path must exist and contain valid schema files. If the CLI fails, the failure response surfaces the underlying cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "generate the DDL", "preview the SQL", "apply the schema").
- Speak in plain language. Summarise the result (dialect, output target, drop mode); do not paste raw DDL unless the user explicitly asks.
- Output is dialect-aware: column types, FK syntax, default value translation, and identifier quoting all change per dialect. Do not assume cross-dialect equivalence.
- The order is topological — parent tables before child tables. DROP order is reversed.
- For preview before applying, this is the safe path. To actually apply, suggest the migrate action next.
- When 'output' is set, the file is written; if it exists, it is overwritten. Confirm with the user if a destructive overwrite is intended.
- If the user wants multi-dialect output, suggest invoking once per dialect.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform)'),
        schemaPath: z
          .string()
          .min(1)
          .describe('Path to schema file or folder relative to cwd (e.g. "schema", "schema/supplier.js").'),
        dialect: z
          .enum(['postgres', 'mysql', 'oracle', 'sqlite'])
          .describe('Target SQL dialect.'),
        output: z
          .string()
          .min(1)
          .optional()
          .describe('Output file path relative to cwd (e.g. "db/migrations/001-init.sql"). When omitted, the DDL is returned in the response (stdout). Existing files at this path are overwritten.'),
        drop: z
          .boolean()
          .optional()
          .describe('Default false. When true, prepend DROP TABLE statements (in reverse topological order) before the CREATE statements.'),
      },
      annotations: {
        title: 'Generate DDL from dbschema-kit Files',
        idempotentHint: true, // pure transformation; same input -> same output (file overwrite is in-place)
      },
    },
    async ({ cwd, schemaPath, dialect, output, drop }) => {
      const projectCwd = resolve(cwd);

      // Precondition check: @restforgejs/platform must be present in node_modules. per §3.4
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
Requested schema path: ${schemaPath}
Requested dialect: ${dialect}
Requested out: ${output ?? '(stdout)'}
Requested drop: ${drop ?? false}

For the assistant:
- The user needs to install the RESTForge package before DDL can be generated.
- Suggest installing the package first, then retry generating the DDL.
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
        'generate-ddl',
        `--schema-path=${schemaPath}`,
        `--dialect=${dialect}`,
      ];
      if (output !== undefined) cliArgs.push(`--output=${output}`);
      if (drop !== undefined) cliArgs.push(`--drop=${drop}`);

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

      // Branch C: CLI failure — real error per §3.4. per §3.5
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to generate DDL.

Project path: ${projectCwd}
Schema path: ${schemaPath}
Dialect: ${dialect}
Output: ${output ?? '(stdout)'}
Drop tables: ${drop ?? false}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that generating the DDL did not complete successfully.
- Summarise the most likely cause from the CLI output in plain language. Common causes:
  * Schema validation failure — a file has invalid syntax or a broken FK reference. Suggest running the validate action first to surface the specific issue.
  * Schema folder not found — the CLI cannot locate the path. Suggest verifying the folder name passed via --schema-path.
  * Missing required flag --schema-path or --dialect — the CLI now requires both explicitly. Confirm both values with the user.
  * Invalid dialect — only postgres, mysql, oracle, sqlite are supported.
  * Output path issue (parent folder missing) — the CLI does not auto-create intermediate folders. Suggest creating them first.
  * Unknown command 'schema generate-ddl' — the installed RESTForge version may be older than this CLI subcommand; suggest upgrading the package.
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.
- Offer to retry once the issue is resolved.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Branch B: success — labeled facts + fenced raw output per §3.5.
      // When 'output' is set, stdout contains a short status message; when not, stdout contains the full DDL.
      return {
        content: [
          {
            type: 'text',
            text: `DDL generated successfully.

Project path: ${projectCwd}
Schema path: ${schemaPath}
Dialect: ${dialect}
Drop tables: ${drop ?? false}
Output: ${output ?? '(stdout)'}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm to the user that the DDL was generated. Mention the dialect and (if applicable) the output file path in plain language.
- DDL is dialect-specific — column types, FK syntax, identifier quoting, and default value translation differ across postgres/mysql/oracle/sqlite. Do not assume cross-dialect equivalence.
- The order is topological — parent tables before child tables. When drop=true, DROP statements are emitted in reverse order before the CREATE block.
- When 'output' was set, the file is written; existing files at that path are overwritten. Mention the file path so the user can review or commit it.
- For preview before applying, this is the safe path. To apply the schema to a live database, suggest the migrate action next.
- If the user wants multi-dialect output, mention that the action can be invoked once per dialect.
- Do not paste the full DDL unless the user explicitly asks.
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
