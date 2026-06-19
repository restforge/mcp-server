import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

// Extract a printable name from a drift item. Items in onlyInSdf/onlyInDb/mismatched
// can be plain strings or objects depending on the section; fall back to JSON for
// unknown shapes. Defensive access per the verified JSON shape (phase 00 T3.1).
function itemName(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item !== null && typeof item === 'object') {
    const o = item as Record<string, unknown>;
    if (typeof o.name === 'string') return o.name;
    if (typeof o.field === 'string') return o.field;
    if (typeof o.column === 'string') return o.column;
  }
  return JSON.stringify(item);
}

// Summarise one { onlyInSdf, onlyInDb, mismatched } drift section. Returns null when
// the section is absent or has no drift, so clean sections stay out of the summary.
function summariseListSection(section: unknown): string | null {
  if (section === null || typeof section !== 'object') return null;
  const s = section as Record<string, unknown>;
  const labels: Record<string, string> = {
    onlyInSdf: 'only-in-SDF',
    onlyInDb: 'only-in-DB',
    mismatched: 'mismatched',
  };
  const parts: string[] = [];
  for (const key of ['onlyInSdf', 'onlyInDb', 'mismatched']) {
    const arr = Array.isArray(s[key]) ? (s[key] as unknown[]) : [];
    if (arr.length > 0) {
      parts.push(`${labels[key]} [${arr.map(itemName).join(', ')}]`);
    }
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

// Summarise a { match, sdf, db } section (primaryKey, softDelete). Returns null when
// match is not explicitly false or the shape is unknown.
function summariseMatchSection(section: unknown): string | null {
  if (section === null || typeof section !== 'object') return null;
  const s = section as Record<string, unknown>;
  if (s.match !== false) return null;
  return `mismatch (SDF: ${JSON.stringify(s.sdf ?? null)} vs DB: ${JSON.stringify(s.db ?? null)})`;
}

// Build the per-table drift lines for the response text. Section order follows the
// JSON shape from phase 00 T3.1: fields, primaryKey, indexes, uniques, foreignKeys,
// checks, softDelete (the last two are optional in the report).
function buildDriftSummary(tables: unknown[]): string {
  const lines: string[] = [];
  for (const t of tables) {
    if (t === null || typeof t !== 'object') continue;
    const table = t as Record<string, unknown>;
    if (table.hasDrift !== true) continue;
    const name = typeof table.tableName === 'string' ? table.tableName : '(unknown table)';
    const sectionLines: string[] = [];
    const fields = summariseListSection(table.fields);
    if (fields) sectionLines.push(`    fields: ${fields}`);
    const pk = summariseMatchSection(table.primaryKey);
    if (pk) sectionLines.push(`    primaryKey: ${pk}`);
    for (const key of ['indexes', 'uniques', 'foreignKeys', 'checks']) {
      const summary = summariseListSection(table[key]);
      if (summary) sectionLines.push(`    ${key}: ${summary}`);
    }
    const softDelete = summariseMatchSection(table.softDelete);
    if (softDelete) sectionLines.push(`    softDelete: ${softDelete}`);
    if (sectionLines.length === 0) {
      sectionLines.push('    (drift flagged but no recognised section detail — see the raw JSON below)');
    }
    lines.push(`- ${name}:`, ...sectionLines);
  }
  return lines.join('\n');
}

export function registerCodegenDbschemaDiff(server: McpServer): void {
  server.registerTool(
    'codegen_dbschema_diff',
    {
      title: 'Diff dbschema-kit Files Against Database',
      description: `Detect schema drift between dbschema-kit SDF files and the live database structure (read-only, bidirectional), by wrapping restforge schema diff. The CLI loads the SDF files, introspects the matching tables in the database, and reports differences in both directions: only-in-SDF (declared but missing in the database), only-in-DB (present in the database but not declared), and mismatched (present on both sides but different). Nothing is written to the database or the filesystem.

EXIT CODE SEMANTICS (important):
- Exit 0 = no drift; schema and database are in sync.
- Exit 1 = drift detected. This is a NORMAL, meaningful result — NOT a failure. The response summarises the drift; treat it as the answer to "is my schema in sync?".
- Exit 2 = system error (invalid config, connection failure, schema path not found, SDF load error).

USE WHEN:
- The user asks "is my schema in sync with the database?", "apakah schema saya sinkron dengan database?", "ada drift nggak?", "cek drift schema"
- After editing SDF files — to check the impact against the live database before deciding what to apply
- After a manual database change (e.g. an ad-hoc ALTER) — to see how far the database diverged from the SDF source
- Before running 'codegen_dbschema_migrate' on an existing database — to know what differs first
- The user wants a safe read-only comparison without modifying anything
- Periodic drift audit of an environment (staging/production) against the SDF folder

DO NOT USE FOR:
- Applying the detected drift to the database -> use 'codegen_dbschema_apply', the incremental complement of this diff (additive ALTER by default; destructive changes need explicit opt-in).
- Full CREATE/DROP deployment of a schema -> use 'codegen_dbschema_migrate' (full apply, mutates the database — a different operation from drift detection)
- Validating SDF file correctness without a database -> use 'codegen_dbschema_validate'
- Reverse-engineering SDF files from the database -> use 'codegen_dbschema_introspect'
- Listing tables or describing a single table -> use 'codegen_list_tables' / 'codegen_describe_table'
- Comparing RDF payload files against the database -> use 'codegen_diff_payload'

This tool runs: npx restforge schema diff --schema-path=<path> --config=<config> --json [--table=<name>] in the given cwd. The --json flag is always sent; the tool parses the JSON drift report (version, summary, per-table sections).

Soft-delete note: the diff is soft-delete aware but non-strict. Drift in the softDelete block is reported as-is in the table's softDelete section without blocking the diff — unlike introspect, which can block on a broken soft-delete contract.

Limitations:
- The sqlite dialect is not supported by schema diff.
- A table declared in SDF but absent in the database is reported as only-in-SDF drift, not as an error.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The config file (default 'db-connection.env') must exist and contain valid database credentials.
- SDF files must exist at the given path. The --schema-path flag is required by the CLI.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "compare the schema with the database", "check for drift").
- Drift detected is NOT an error. Present it as a factual comparison result: which tables drifted and in which direction (only-in-SDF / only-in-DB / mismatched).
- Speak in plain language. Summarise per table; do not paste the raw JSON unless the user explicitly asks.
- This is a read-only live comparison: the database is introspected at diff time and never modified.
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
          .describe('Diff only one specific table. When omitted, all tables in the schema path are compared.'),
      },
      annotations: {
        title: 'Diff dbschema-kit Files Against Database',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, config, schemaPath, table }) => {
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

For the assistant:
- The user needs to install the RESTForge package before the schema can be diffed against the database.
- Suggest installing the package first, then retry the drift check.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // --json is always sent: the CLI default is a human-readable report, while this
      // tool depends on JSON.parse of stdout. There is no --dry-run flag — schema diff
      // is read-only by design. Optional flags forwarded only when supplied. per §3.5
      const cliArgs = [
        'restforge',
        'schema',
        'diff',
        `--schema-path=${schemaPath}`,
        `--config=${config}`,
        '--json',
      ];
      if (table !== undefined) cliArgs.push(`--table=${table}`);

      const result = await execProcess(
        'npx',
        cliArgs,
        {
          cwd: projectCwd,
          timeout: 60_000, // diff introspects every table in the schema path; more headroom than a single catalog query
          env: { NODE_ENV: 'production' },
          stripFinalNewline: true,
        }
      );

      // Exit code semantics are part of the CLI spec: 0 = no drift, 1 = drift detected
      // (a meaningful result, NOT an error), 2 = system error. execProcess treats only
      // exit 0 as success, so exit 1 is re-routed into the result branches below.
      const driftDetected = result.exitCode === 1;

      // Branch C: system error (exit 2 or any other non-0/1 exit). per §3.4
      if (!result.success && !driftDetected) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to diff schema against the database.

Project path: ${projectCwd}
Config: ${config}
Schema path: ${schemaPath}
Table filter: ${table ?? 'all tables'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that the drift check could not run. This is a system error, not a drift result.
- Summarise the most likely cause from the CLI output in plain language. Common causes:
  * Config file not found or invalid — suggest verifying the config path and its content.
  * Database connection failed — suggest verifying credentials, host, and port.
  * Schema path not found — the CLI cannot locate the path. Suggest verifying the folder or file name passed via --schema-path.
  * SDF load error — a schema file has invalid syntax or violates the defineModel contract. Suggest running the validate action first to surface the specific issue.
  * Unsupported dialect — schema diff does not support sqlite. Suggest checking DB_TYPE in the config.
  * Unknown command 'schema diff' — the installed RESTForge version may be older than this CLI subcommand; suggest upgrading the package.
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.
- Offer to retry once the underlying issue is resolved.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Branch D: JSON parse failure on exit 0/1 — real error per §3.4 (the CLI
      // completed but produced output this tool cannot read).
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to parse the schema drift report as JSON.

Project path: ${projectCwd}
Config: ${config}
Schema path: ${schemaPath}
Exit code: ${result.exitCode}
Reason: ${msg}

--- Raw stdout ---
${result.stdout}
--- end Raw stdout ---

For the assistant:
- The CLI returned output that is not valid JSON, so the drift result could not be read.
- Summarise this to the user in plain language; do not paste the raw stdout unless they explicitly ask.
- Suggest checking that the installed RESTForge package version is compatible. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Defensive labeled facts: if the JSON shape changes upstream, fall back to
      // 'unknown' rather than crashing. Mirror the list-tables pattern.
      const root = (parsed ?? {}) as Record<string, unknown>;
      const summary = (root.summary ?? {}) as Record<string, unknown>;
      const totalTables =
        typeof summary.totalTables === 'number' ? summary.totalTables : 'unknown';
      const tablesWithDrift =
        typeof summary.tablesWithDrift === 'number' ? summary.tablesWithDrift : 'unknown';
      const tablesClean =
        typeof summary.tablesClean === 'number' ? summary.tablesClean : 'unknown';
      const tables = Array.isArray(root.tables) ? (root.tables as unknown[]) : [];

      const prettyJson = JSON.stringify(parsed, null, 2);

      // Branch B (no drift): exit 0 — schema and database are in sync. per §3.5
      if (!driftDetected) {
        return {
          content: [
            {
              type: 'text',
              text: `Schema drift check completed: no drift detected.

Project path: ${projectCwd}
Config: ${config}
Schema path: ${schemaPath}
Table filter: ${table ?? 'all tables'}
totalTables: ${totalTables}
tablesWithDrift: ${tablesWithDrift}
tablesClean: ${tablesClean}

For the assistant:
- Confirm to the user that the schema files and the database are in sync — mention the number of tables compared in plain language.
- This was a read-only comparison; nothing in the database or the filesystem was modified.
- No follow-up action is required. If the user expected drift, suggest double-checking that the schema path and config point at the intended files and database.
- Match the user's language.`,
            },
          ],
        };
      }

      // Branch B (drift): exit 1 — drift detected, a meaningful result, NOT an error. per §3.5
      const driftSummary = buildDriftSummary(tables);
      return {
        content: [
          {
            type: 'text',
            text: `Schema drift check completed: drift detected (this is a result, not an error).

Project path: ${projectCwd}
Config: ${config}
Schema path: ${schemaPath}
Table filter: ${table ?? 'all tables'}
totalTables: ${totalTables}
tablesWithDrift: ${tablesWithDrift}
tablesClean: ${tablesClean}

--- Drift summary per table ---
${driftSummary}
--- end Drift summary ---

--- Drift report (JSON) ---
${prettyJson}
--- end Drift report (JSON) ---

For the assistant:
- Present this as a factual comparison result, NOT a failure: the schema files and the database differ.
- Summarise per drifted table in plain language: only-in-SDF means declared in the schema files but missing in the database; only-in-DB means present in the database but not declared; mismatched means present on both sides with different definitions.
- A whole table reported as only-in-SDF fields drift usually means the table does not exist in the database yet.
- Drift in the softDelete section is informational (non-strict) — report it as-is without treating it as a blocker.
- Do not paste the full JSON unless the user asks; the per-table summary above is usually enough.
- For next steps, depending on direction: additive changes can be applied incrementally via 'codegen_dbschema_apply' (preview with dryRun=true first; destructive changes need explicit user opt-in); a full re-deploy goes through the migrate action (destructive — needs explicit confirmation). When speaking to the user, describe these as actions — do not mention internal tool names.
- This was a read-only comparison; nothing was modified.
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
