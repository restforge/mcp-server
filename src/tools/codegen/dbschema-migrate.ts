import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenDbschemaMigrate(server: McpServer): void {
  server.registerTool(
    'codegen_dbschema_migrate',
    {
      title: 'Migrate dbschema-kit Files to Database',
      description: `Apply dbschema-kit definition files to a live database (load -> validate -> generate DDL -> apply via dialect driver), by wrapping restforge schema migrate. This is the only tool in the dbschema-kit family that MUTATES a live database. The DESTRUCTIVE annotation is set deliberately: with drop=true, all data in the affected tables is destroyed before recreation.

USE WHEN:
- The user explicitly asks to apply schema to a database, "deploy schema", "migrate schema ke DB"
- Pertanyaan dalam bentuk: "create tables di postgres", "apply DDL ke MySQL", "buat schema di production DB"
- Schema-driven development workflow finalisation
- After validating schema (codegen_dbschema_validate) and the user confirmed apply
- Initial DB setup for a new project
- The user wants dry-run first to preview DDL — pass dryRun=true (safe path)
- The user wants to drop and recreate tables (DESTRUCTIVE) — pass drop=true with explicit user confirmation
- After 'codegen_dbschema_introspect' followed by edits, to apply the modified schema

DO NOT USE FOR:
- Generating DDL without applying -> use 'codegen_dbschema_generate_ddl'
- Validating schema correctness -> use 'codegen_dbschema_validate'
- Listing live tables -> use 'codegen_list_tables'
- Querying data -> out of scope
- Incremental ALTER migration — this tool does full apply only. For incremental migrations, suggest a manual SQL migration script.
- Production database without explicit user authorisation — DESTRUCTIVE; never proceed without confirmation.

This tool runs: npx restforge schema migrate --schema-path=<path> --config=<file> [--drop=<bool>] [--dry-run] [--max-name-length=<N>] [--auto-create-db] in the given cwd.
The CLI auto-detects the dialect from the config file (DB_TYPE=postgresql|mysql|oracle|sqlite). The CLI exits 0 on success for BOTH a real apply and a dry-run preview (the legacy exit code 2 for dry-run has been removed); any non-zero exit is an error. This tool distinguishes a dry-run preview from a real apply by the dryRun parameter, not by the exit code.
Tables declared with softDelete enabled emit the same soft-delete DDL as generate-ddl: a consistency CHECK named chk_<table>_soft_delete_consistency and PostgreSQL partial indexes (WHERE is_deleted = FALSE) for non-unique indexes. Soft-delete is PostgreSQL-only in Phase 1 — migrating such a schema against any other dialect fails with a clear error.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The config file (default 'db-connection.env') must exist and contain valid database credentials.
- Schema files must exist at the given path and pass validation. The --schema-path flag is required by the CLI.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "apply the schema", "preview the DDL", "drop and recreate the tables").
- Speak in plain language. Summarise the result; do not paste raw CLI output unless the user explicitly asks.
- This tool MUTATES a live database. ALWAYS confirm with the user before invoking with dryRun=false. The default safe path is dryRun=true (preview only).
- When the user uses drop=true, ALL DATA in the affected tables is destroyed. Confirm explicitly that the user understands this — quote the tables that will be dropped if known.
- Production database operations should be opt-in. If the config points to production (verify by reading DB_HOST or similar), strongly suggest dry-run + manual review first.
- There is no rollback on failure mid-migration — DDL changes that already executed are NOT automatically reverted. Plan for forward-fix only.
- The user must specify --schema-path (e.g. './schema'). The CLI no longer accepts a positional argument or default. If the user does not mention a path, confirm it before invoking.
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
          .describe('Config file name relative to the project, used by the CLI to connect to the database'),
        schemaPath: z
          .string()
          .min(1)
          .describe('Path to schema file or folder relative to cwd (e.g. "./schema"). Required by the CLI.'),
        drop: z
          .boolean()
          .optional()
          .describe('Default false. When true, drop tables before recreating them. DESTRUCTIVE — destroys all data in those tables. Require explicit user confirmation before passing true.'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Default false. When true, generate DDL and preview it without applying. Safe path: prefer this on the first call.'),
        maxNameLength: z
          .number()
          .optional()
          .describe('Optional override for the maximum database identifier length, mapped to --max-name-length=<N>. Sent only when supplied. The CLI already applies the correct default per dialect (postgres 63, mysql 64, oracle 128, sqlite 63), so this is rarely needed — leave it unset unless a specific identifier-length conflict requires a smaller bound.'),
        autoCreateDb: z
          .boolean()
          .optional()
          .describe('Default false. PostgreSQL/MySQL only; mapped to the bare flag --auto-create-db, sent only when true. When the target database does not yet exist, the CLI creates it and then STOPS with exit 0 and a re-run instruction — it does NOT continue to apply the tables in the same call. After an auto-create, the migrate action must be invoked a second time to apply the schema. Read the CLI output to tell "database created, please re-run" apart from "tables applied".'),
      },
      annotations: {
        title: 'Migrate dbschema-kit Files to Database',
        destructiveHint: true,  // mutates live DB; with drop=true also destroys data
        idempotentHint: false,  // re-running on a fresh DB will fail (tables already exist) unless drop=true
      },
    },
    async ({ cwd, config, schemaPath, drop, dryRun, maxNameLength, autoCreateDb }) => {
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
Requested config: ${config}
Requested schema path: ${schemaPath}
Requested drop: ${drop ?? false}
Requested dryRun: ${dryRun ?? false}

For the assistant:
- The user needs to install the RESTForge package before the schema can be migrated.
- Suggest installing the package first, then retry the migration.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // CLI v4+ requires --path as a flag (no positional, no default). Other
      // optional flags are only forwarded when the user supplied them. per §3.5
      const cliArgs = [
        'restforge',
        'schema',
        'migrate',
        `--schema-path=${schemaPath}`,
        `--config=${config}`,
      ];
      if (drop !== undefined) cliArgs.push(`--drop=${drop}`);
      if (dryRun === true) cliArgs.push('--dry-run');
      if (maxNameLength !== undefined) cliArgs.push(`--max-name-length=${maxNameLength}`);
      if (autoCreateDb === true) cliArgs.push('--auto-create-db');

      const result = await execProcess(
        'npx',
        cliArgs,
        {
          cwd: projectCwd,
          timeout: 120_000, // schema apply on a populated DB can be slow
          env: { NODE_ENV: 'production' },
          stripFinalNewline: true,
        }
      );

      // The CLI now exits 0 for a successful dry-run as well as a real apply (the
      // legacy exit code 2 dry-run sentinel was removed in platform v5.1.17). The
      // dry-run vs apply distinction is therefore driven by the dryRun parameter,
      // not by the exit code. per D-06.2

      // Branch C: real CLI failure (any non-zero exit). per §3.4
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to migrate schema to database.

Project path: ${projectCwd}
Config: ${config}
Schema path: ${schemaPath}
Drop: ${drop ?? false}
DryRun: ${dryRun ?? false}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that the migration did not complete successfully.
- Summarise the most likely cause from the CLI output in plain language. Common causes:
  * Config file not found — suggest verifying the config path and that the file exists.
  * Database connection failed — suggest verifying credentials, host, and port.
  * Schema validation error — a schema file has invalid syntax or a broken FK reference. Suggest running the validate action first to surface the specific issue.
  * Schema folder not found — the CLI cannot locate the path. Suggest verifying the folder name passed via --schema-path.
  * Missing required flag --schema-path — the CLI now requires this flag explicitly. Confirm the path with the user.
  * Apply error mid-transaction — DDL changes that already executed before the failure are NOT automatically reverted. The user must inspect the DB state manually and plan a forward-fix.
  * Tables already exist (without drop=true) — the CLI does full apply only. Suggest dry-run + manual review of the existing schema, or pass drop=true with explicit user confirmation.
  * Unknown command 'schema migrate' — the installed RESTForge version may be older than this CLI subcommand; suggest upgrading the package.
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.
- For destructive failures (mid-apply error with partial DDL execution), strongly suggest the user reviews the DB state before any retry.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      if (dryRun === true) {
        // Branch B (dry-run): preview only, no DDL applied. Reached on exit 0 with
        // dryRun=true (the CLI printed the DDL preview and exited cleanly). per §3.5
        return {
          content: [
            {
              type: 'text',
              text: `Schema migration dry-run completed (no changes applied).

Project path: ${projectCwd}
Config: ${config}
Schema path: ${schemaPath}
Mode: dry-run

--- DDL preview ---
${result.stdout}
--- end DDL preview ---

For the assistant:
- Confirm to the user that this was a preview only. No DDL was applied to the database.
- The DDL shown above is what would be applied if the same action is rerun without dry-run.
- Encourage reviewing the DDL before applying. For destructive operations (drop=true), strongly suggest the user reviews the DROP TABLE list carefully and confirms the data destruction is intended.
- Match the user's language.`,
            },
          ],
        };
      }

      // When autoCreateDb is enabled, the CLI may CREATE THE DATABASE ONLY and then
      // stop (exit 0) with a re-run instruction instead of applying tables — see
      // platform migrate.js (handleMissingDatabase: created -> return). That output
      // lands in this success branch, so the guidance must steer the assistant to
      // read stdout rather than assume the tables were applied. per §3.5
      const autoCreateNote =
        autoCreateDb === true
          ? `
- CAUTION — auto-create-db was enabled. If the target database did not exist, the CLI may have CREATED ONLY THE DATABASE and then STOPPED with a re-run instruction, WITHOUT applying any tables. Read the CLI output above carefully: if it contains a re-run instruction (for example "database created ... re-run the command"), do NOT claim the tables were created. Instead tell the user the database was provisioned and the migrate action must be run a second time to apply the schema.`
          : '';

      // Branch B (apply): real apply succeeded (exit 0 with dryRun not requested). per §3.5
      return {
        content: [
          {
            type: 'text',
            text: `Schema migration applied successfully.

Project path: ${projectCwd}
Config: ${config}
Schema path: ${schemaPath}
Mode: apply
Drop tables before recreate: ${drop ?? false}
Auto-create database: ${autoCreateDb ?? false}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm to the user that the migration was applied. Read the CLI output above and mention the database type and the count of tables/indexes/foreign keys created (when present).${autoCreateNote}
- This is a DESTRUCTIVE operation: tables, indexes, and foreign keys were created in the live database. With drop=true, existing tables and their data were also removed before recreation.
- The user should verify the database state matches expectation. Suggest listing tables (read-only) for confirmation.
- For follow-up changes, the user authors updated schema files and reruns the migrate action. Caution: there is no incremental ALTER migration in this version — full apply only. Schema-driven incremental migration is out of scope.
- There is no rollback on partial failure — if a future migration fails mid-way, DDL that already executed is NOT automatically reverted.
- Do not paste the raw CLI output unless the user explicitly asks.
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
