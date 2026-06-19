import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

// Pull one labelled block (e.g. 'Warnings:' or 'Summary:') out of the structured
// human-readable stdout. The CLI prints the header on its own line and the block
// ends at the first blank line. Defensive: returns null when the header is absent
// or the shape is unexpected — the caller then falls back to the full stdout.
function extractBlock(stdout: string, header: string): string | null {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) return null;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

// Compose the Warnings + Summary excerpt for the opt-in branch. Falls back to a
// pointer line when neither block is found, so the response never loses signal.
function extractWarningsAndSummary(stdout: string): string {
  const parts: string[] = [];
  const warnings = extractBlock(stdout, 'Warnings:');
  if (warnings) parts.push(warnings);
  const summary = extractBlock(stdout, 'Summary:');
  if (summary) parts.push(summary);
  if (parts.length === 0) {
    return '(no Warnings:/Summary: blocks recognised — see the full CLI output above)';
  }
  return parts.join('\n\n');
}

export function registerCodegenDbschemaApply(server: McpServer): void {
  server.registerTool(
    'codegen_dbschema_apply',
    {
      title: 'Apply Schema Drift Incrementally via ALTER',
      description: `Resolve schema drift from dbschema-kit SDF files to the live database via incremental ALTER TABLE statements, by wrapping restforge schema apply. This is the incremental complement of 'codegen_dbschema_diff' (which only detects drift) and the SAFE alternative to 'codegen_dbschema_migrate' with drop=true (which destroys and recreates tables). By default the apply is ADDITIVE-ONLY: ADD COLUMN, CREATE INDEX, ADD UNIQUE, and ADD FOREIGN KEY are emitted; every destructive change is skipped with a warning unless explicitly opted in (allowDrop for DROP COLUMN/INDEX/UNIQUE/FOREIGN KEY, allowModify for ALTER COLUMN length/nullable and FOREIGN KEY action changes).

RECOMMENDED WORKFLOW:
1. Run 'codegen_dbschema_diff' first to see the drift.
2. Run this tool with dryRun=true to preview the exact ALTER statements.
3. Show the preview to the user and ask for confirmation.
4. Only then run with dryRun=false to apply. Pass allowDrop/allowModify ONLY when the user explicitly asked for that destructive change — never to "make a warning go away".

EXIT CODE SEMANTICS (important):
- Exit 0 = success: every applicable drift was applied (or previewed in dry-run, or there was no drift). The output may still contain warnings for operations the platform defers (see below) — relay those.
- Exit 1 = some drift was SKIPPED because it requires allowDrop or allowModify. This is a NORMAL, meaningful result — NOT a failure. In a real apply the additive statements WERE applied; only the skipped items remain. NEVER retry automatically with allowDrop/allowModify: those options drop or mutate data and need explicit user confirmation first.
- Exit 2 = system error (invalid config, SDF load failure, connection failure, or apply failure). ROLLBACK means the database is unchanged; PARTIAL means some statements were applied and the database needs manual inspection.

USE WHEN:
- 'codegen_dbschema_diff' reported drift and the user wants to bring the database in sync incrementally
- The user asks "apply the drift", "sinkronkan database dengan schema", "tambahkan kolom yang kurang ke database", "apply perubahan schema tanpa drop"
- Evolving an existing populated database without recreating tables (data preserved)
- The user wants a preview of the ALTER statements first — pass dryRun=true (safe path)

DO NOT USE FOR:
- Detecting drift without changing anything -> use 'codegen_dbschema_diff' (read-only)
- Full CREATE/DROP deployment of a schema or initial setup of an empty database -> use 'codegen_dbschema_migrate'
- Retrofitting the soft-delete consistency CHECK -> not supported here (detection-only); goes through 'codegen_dbschema_migrate' with drop (destructive) or manual SQL
- Type changes, PK changes, default value changes, CHECK constraint changes -> not supported by the platform yet (always skipped); suggest a manual SQL migration
- Validating SDF file correctness -> use 'codegen_dbschema_validate'
- Reverse-engineering SDF files from the database -> use 'codegen_dbschema_introspect'

This tool runs: npx restforge schema apply --schema-path=<path> --config=<config> [--table=<name>] [--dry-run] [--allow-drop] [--allow-modify] in the given cwd. The output is a structured human-readable report (DDL preview or per-statement progress, Warnings, Summary) — there is no JSON mode.

OPERATIONS NOT SUPPORTED by the platform yet (always skipped with a 'deferred' warning, regardless of opt-in flags):
- ALTER COLUMN type change (needs a data conversion strategy per dialect)
- ALTER COLUMN precision/scale change
- DEFAULT value change
- PRIMARY KEY changes (need a table rebuild)
- CHECK constraint add/drop
On SQLite, MODIFY/DROP COLUMN and ALL foreign key changes are additionally skipped ('sqlite limitation') even with opt-in flags; the sqlite dialect is rejected entirely by the default introspector.

Soft-delete note: drift in the soft-delete consistency CHECK is detection-only. It is reported as a warning (never auto-applied) and does NOT by itself cause exit 1; the warning text suggests retrofitting via 'schema migrate --drop' (recreate) or adding the CHECK manually.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The config file (default 'db-connection.env') must exist and contain valid database credentials.
- SDF files must exist at the given path. The --schema-path flag is required by the CLI.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "apply the missing columns", "preview the ALTER statements").
- Exit 1 is NOT an error. Present it as: "these changes were applied/previewed, these were skipped because they would drop or modify existing data". Then ask the user whether they want the destructive part — do not decide for them.
- This tool MUTATES the live database when dryRun=false. Prefer dryRun=true on the first call and confirm with the user before the real apply.
- Speak in plain language. Summarise the applied/skipped items; do not paste raw CLI output unless the user explicitly asks.
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
          .describe('Path to schema file or folder relative to cwd (e.g. "./schema" or "schema/users.js"). Required by the CLI.'),
        table: z
          .string()
          .min(1)
          .optional()
          .describe('Apply only one specific table. When omitted, all models in the schema path are processed.'),
        dryRun: z
          .boolean()
          .default(false)
          .describe('Default false. When true, preview the ALTER statements without applying. Safe path: prefer this on the first call.'),
        allowDrop: z
          .boolean()
          .default(false)
          .describe('Default false. Opt-in for DROP COLUMN/INDEX/UNIQUE/FOREIGN KEY (destroys data or constraints). Require explicit user confirmation before passing true.'),
        allowModify: z
          .boolean()
          .default(false)
          .describe('Default false. Opt-in for ALTER COLUMN length/nullable and FOREIGN KEY action changes (potential data loss). Require explicit user confirmation before passing true.'),
      },
      annotations: {
        title: 'Apply Schema Drift Incrementally via ALTER',
        destructiveHint: true,  // mutates the live database; with opt-in flags also drops columns/constraints
        idempotentHint: false,  // re-running applies whatever drift remains; state-dependent
      },
    },
    async ({ cwd, config, schemaPath, table, dryRun, allowDrop, allowModify }) => {
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
Requested table filter: ${table ?? 'all tables'}
Requested dryRun: ${dryRun}

For the assistant:
- The user needs to install the RESTForge package before drift can be applied to the database.
- Suggest installing the package first, then retry the apply.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Boolean flags are only forwarded when true, following the migrate/introspect
      // pattern. There is no JSON output mode for schema apply. per §3.5
      const cliArgs = [
        'restforge',
        'schema',
        'apply',
        `--schema-path=${schemaPath}`,
        `--config=${config}`,
      ];
      if (table !== undefined) cliArgs.push(`--table=${table}`);
      if (dryRun === true) cliArgs.push('--dry-run');
      if (allowDrop === true) cliArgs.push('--allow-drop');
      if (allowModify === true) cliArgs.push('--allow-modify');

      const result = await execProcess(
        'npx',
        cliArgs,
        {
          cwd: projectCwd,
          timeout: 120_000, // introspection + ALTER execution on a populated DB can be slow
          env: { NODE_ENV: 'production' },
          stripFinalNewline: true,
        }
      );

      // Exit code semantics are part of the CLI spec: 0 = all applicable drift
      // applied (or no drift), 1 = some drift skipped pending opt-in (a meaningful
      // result, NOT an error), 2 = system error. Deliberately NO "exit 2 = dry-run
      // success" sentinel here: a successful apply dry-run exits 0 or 1.
      const optInRequired = result.exitCode === 1;

      // Branch C: system error (exit 2 or any other non-0/1 exit). per §3.4
      if (!result.success && !optInRequired) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to apply schema drift to the database.

Project path: ${projectCwd}
Config: ${config}
Schema path: ${schemaPath}
Table filter: ${table ?? 'all tables'}
Mode: ${dryRun ? 'dry-run' : 'apply'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that the apply could not complete. This is a system error, not a drift result.
- Check the CLI output for ROLLBACK or PARTIAL status first:
  * ROLLBACK applied — the database state is UNCHANGED; the failed statement is reported. Safe to fix the cause and retry.
  * Partial apply detected — SOME statements were applied before the failure and were NOT reverted. The user must inspect the database state manually before any retry.
- Other common causes, in plain language:
  * Config file not found or invalid — suggest verifying the config path and its content.
  * Database connection failed — suggest verifying credentials, host, and port.
  * Schema path not found or no models in it — suggest verifying the folder or file name passed via --schema-path.
  * SDF load error — a schema file has invalid syntax or violates the defineModel contract. Suggest running the validate action first.
  * Table filter not found in SDF — the --table value does not match any model.
  * Unsupported dialect — schema apply does not support sqlite. Suggest checking DB_TYPE in the config.
  * Unknown command 'schema apply' — the installed RESTForge version may be older than this CLI subcommand; suggest upgrading the package.
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.
- Offer to retry once the underlying issue is resolved (after manual inspection in the PARTIAL case).`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Branch B (opt-in required): exit 1 — part of the drift was skipped because
      // it needs --allow-drop / --allow-modify. A meaningful result, NOT an error.
      if (optInRequired) {
        const excerpt = extractWarningsAndSummary(result.stdout);
        return {
          content: [
            {
              type: 'text',
              text: `Schema apply ${dryRun ? 'dry-run ' : ''}completed with skipped drift: some changes require explicit opt-in (this is a result, not an error).

Project path: ${projectCwd}
Config: ${config}
Schema path: ${schemaPath}
Table filter: ${table ?? 'all tables'}
Mode: ${dryRun ? 'dry-run (nothing applied)' : 'apply (additive statements WERE applied)'}

--- Warnings and Summary (from the CLI) ---
${excerpt}
--- end Warnings and Summary ---

--- Full CLI output ---
${result.stdout}
--- end Full CLI output ---

For the assistant:
- Present this as a two-part factual result: (1) what was ${dryRun ? 'previewed' : 'applied'} — see the ${dryRun ? 'DDL preview' : 'progress lines'} in the full output; (2) what was SKIPPED — the Warnings above list each skipped item with its reason ('requires --allow-drop' or 'requires --allow-modify').
- ${dryRun ? 'This was a preview only. Nothing was applied to the database.' : 'The additive statements were applied to the live database; only the skipped items remain outstanding.'}
- Do NOT retry with allowDrop/allowModify on your own. Those options drop columns/constraints or alter existing columns — explain to the user what would be dropped or modified, and only proceed after the user explicitly confirms.
- Warnings with reason 'deferred', 'detection-only', or 'sqlite limitation' cannot be resolved by opt-in flags at all — those need a manual migration or a full recreate; say so plainly.
- Do not paste the full CLI output unless the user asks; the Warnings/Summary excerpt is usually enough.
- Match the user's language.`,
            },
          ],
          isError: false, // exit 1 = drift pending opt-in, a normal result per CLI spec
        };
      }

      // Branch B (dry-run success): exit 0 with --dry-run — preview only.
      if (dryRun) {
        return {
          content: [
            {
              type: 'text',
              text: `Schema apply dry-run completed (no changes applied).

Project path: ${projectCwd}
Config: ${config}
Schema path: ${schemaPath}
Table filter: ${table ?? 'all tables'}
Mode: dry-run

--- DDL preview ---
${result.stdout}
--- end DDL preview ---

For the assistant:
- Confirm to the user that this was a preview only. No ALTER statement was applied to the database.
- The statements shown above are exactly what would run if the same action is repeated without dry-run. "No applicable ALTER statements." means schema and database are already in sync for the applicable operations.
- If a Warnings block is present, relay it: warnings with reason 'deferred', 'detection-only', or 'sqlite limitation' are operations the platform cannot apply incrementally yet (they do not block the rest).
- Encourage the user to review the preview, then confirm before running the real apply.
- Match the user's language.`,
            },
          ],
        };
      }

      // Branch B (apply success): exit 0 — every applicable drift applied (or no drift).
      return {
        content: [
          {
            type: 'text',
            text: `Schema apply completed successfully: all applicable drift was applied.

Project path: ${projectCwd}
Config: ${config}
Schema path: ${schemaPath}
Table filter: ${table ?? 'all tables'}
Mode: apply
allowDrop: ${allowDrop}
allowModify: ${allowModify}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm to the user that the incremental changes were applied to the live database. "No drift to apply." means schema and database were already in sync.
- Read the Summary in the CLI output and mention the number of statements applied in plain language.
- If skipped warnings are present (reason 'deferred', 'detection-only', or 'sqlite limitation'), relay them: those operations cannot be applied incrementally yet and need a manual migration or a full recreate. They did not block this apply.
- Suggest verifying the result with a drift check (read-only) if the user wants confirmation that everything is now in sync.
- Do not paste the raw CLI output unless the user explicitly asks.
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
