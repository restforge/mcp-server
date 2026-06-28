import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenSyncPayload(server: McpServer): void {
  server.registerTool(
    'codegen_sync_payload',
    {
      title: 'Sync Payload',
      description: `Apply schema drift to existing payload spec files in a project, archiving the previous version of each updated file, by running restforge payload --sync.

USE WHEN:
- The user asks to apply schema drift changes to payload files, sync payload files with the database, or update payload JSON files to match the current schema
- The user asks things like "sinkronisasi payload", "update payload sesuai database", "apply schema drift", "sync payload files", "terapkan perubahan schema", "samakan payload dengan database"
- After 'codegen_diff_payload' reported column-level differences and the user has reviewed them, wanting to apply the changes
- After ALTER TABLE in the database when the user wants to bring all payload files in line with the new schema
- The user mentions creating an archive of the previous payload before regenerating endpoints
- The user wants to surface columns from a JOINED/referenced table in datatables (e.g. show supplier_name / warehouse_name alongside the base table) — use the FK expansion mode (expandFk). This generates query/<table>-join.sql from the table's foreign keys and points datatablesQuery/viewQuery at it. Phrases like "tambahkan kolom dari tabel relasi", "tampilkan nama supplier di datatables", "expand foreign key", "kolom join di datatables".
- Before applying changes, strongly consider calling 'codegen_diff_payload' first to confirm what will change in each file (read-before-write per §5.3 — sync overwrites the active payload file and produces an archive that the user may want to inspect later).

FK EXPANSION (expandFk):
- 'expandFk' is opt-in and REQUIRES 'table' (single-table target). Without 'expandFk' the sync behavior is unchanged (pure schema drift).
- When set, the CLI builds a JOIN from the table's foreign keys, writes query/<table>-join.sql, and rewrites datatablesQuery/viewQuery to reference it — this is how join columns get into datatables (the generator does NOT produce them).
- 'fkColumns' is optional: a comma-separated list of QUALIFIED 'table.column' entries (e.g. 'supplier.supplier_code,supplier.supplier_name'). When omitted, the display column per FK is auto-resolved (name/nama -> code/kode -> primary key).
- If the table has no foreign keys, the CLI reports it and makes no JOIN — relay that to the user.

DO NOT USE FOR:
- Just checking which payload files have drift (without modifying anything) -> use 'codegen_validate_payload'
- Looking at the per-column differences without applying them -> use 'codegen_diff_payload'
- Generating a payload from scratch for a table that has no payload yet -> use 'codegen_generate_payload'
- Cleaning up or deleting old '.archive.NNN' files — this tool does not handle archive cleanup; the user must remove archive files manually if desired

This tool runs: npx restforge payload sync --config=<config> [--table=<table>] [--expand-fk [--fk-columns=table.col,table.col]] in the given cwd.
The CLI reads existing payload JSON files from the project payload/ directory, connects to the database described
in the config file, and rewrites each payload file whose schema has drifted. Before overwriting, the
previous file content is renamed to '<filename>.archive.NNN' (NNN is a sequential number starting at 001).
Files that are already in sync are not touched. The CLI prints a per-file status (typically [SKIP],
[ARCHIVE], [SYNCED]) followed by a Summary section with totals.

If the sync run fails partway through (e.g. database connection drops), the CLI restores the archived
file back to its original name so the active payload is not left corrupted.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The config file (default 'db-connection.env') must exist in the project and contain valid
  database credentials. This tool does not pre-check that — if the CLI fails, the failure response
  will surface the underlying cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "update the payload files", "see the column-level differences first", "regenerate the endpoint code from the updated payload").
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
          .describe('Specific table name to sync (e.g. supplier or core.supplier). When omitted, all payload files in the payload/ directory are synced.'),
        expandFk: z
          .enum(['both', 'datatables-only'])
          .optional()
          .describe("Opt-in FK expansion mode. 'both': write query/<table>-join.sql and point both datatablesQuery and viewQuery at it. 'datatables-only': same but viewQuery is left unchanged (use when viewQuery already points to a custom SQL file). REQUIRES table. When omitted, sync only applies schema drift."),
        fkColumns: z
          .string()
          .min(1)
          .optional()
          .describe("Override display columns for specific FKs. Format: 'ref_table.column' for unambiguous FKs, or 'local_fk_col:ref_table.column' to disambiguate when the same table is referenced by multiple FK columns (e.g. 't_group_id:t_group.nama,t_group_id_d1:t_group.kode'). FKs not listed here are auto-resolved. When omitted entirely, all FKs are auto-resolved; duplicate FK targets are auto-disambiguated using the local FK column name as prefix."),
      },
      annotations: {
        title: 'Sync Payload',
        readOnlyHint: false,    // tool menulis ulang file payload + membuat file archive
        idempotentHint: false,  // memanggil ulang dapat menambah file archive baru jika DB berubah lagi di antara panggilan
      },
    },
    async ({ cwd, config, table, expandFk, fkColumns }) => {
      const projectCwd = resolve(cwd);

      // FK expansion requires a single-table target. Guard before touching the
      // package / spawning the CLI, mirroring the CLI's own upfront check.
      // Treated as a non-error precondition per the authoring guide §3.4.
      if (expandFk && !table) {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: FK expansion needs a specific table.

Project path: ${projectCwd}
Config: ${config}
Requested: expandFk without a table

For the assistant:
- FK expansion (expandFk) only works on a single table, so a 'table' must be provided.
- Ask the user which table to expand, then retry with that table.
- Do not mention internal tool names in the reply to the user.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

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
- The user needs to install the RESTForge package before payload files can be synced with the database schema.
- Use the appropriate package-installation tool to do this, then retry syncing the payload.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied. Defaults inside restforge
      // (e.g. payload/ as the default output dir, all files when --table is omitted)
      // should remain in effect when the user does not specify them. per §3.5
      const args = ['restforge', 'payload', 'sync', `--config=${config}`];
      if (table) args.push(`--table=${table}`);
      if (expandFk) {
        args.push(`--expand-fk=${expandFk}`);
        if (fkColumns) args.push(`--fk-columns=${fkColumns}`);
      }

      // Timeout raised to 60s (vs 30s for validate/diff): sync writes payload files
      // and renames each previous version to a sequential archive, which can take
      // longer than read-only operations on projects with many payload files.
      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 60_000 });

      // CLI failure: real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to sync payload.

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
- Tell the user that updating the payload files did not complete successfully.
- Summarise the likely cause from the CLI output in plain language (common causes: the config file is missing or has incomplete credentials, the database is unreachable, the requested table does not exist, or the payload directory is empty). Do not paste the raw stdout/stderr unless the user explicitly asks.
- Reassure the user: when a sync run fails, the CLI automatically restores any payload file that was just archived back to its original name, so the active payload files are not left in a corrupted state.
- Offer to retry once the underlying issue is resolved. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Success: one-line summary + labeled facts + fenced raw output per §3.5.
      // The CLI prints per-file status lines ([SKIP] / [ARCHIVE] / [SYNCED]) and a
      // Summary section with totals. The model should extract the counts and the
      // archive filenames from stdout when talking to the user. per §5.2 cross-ref
      // back to validate/diff.
      return {
        content: [
          {
            type: 'text',
            text: `Payload sync completed.

Project path: ${projectCwd}
Config: ${config}
Table: ${table ?? 'all'}
FK expansion: ${expandFk ? `on${fkColumns ? ` (fk-columns: ${fkColumns})` : ' (auto-resolved display columns)'}` : 'off'}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Read the Summary section in the CLI output above and tell the user how many payload files were SYNCED and how many were SKIPPED (already in sync). Do not paste the raw CLI output unless the user explicitly asks.
- If FK expansion was on, tell the user that a JOIN query file (query/<table>-join.sql) was generated from the table's foreign keys and datatablesQuery/viewQuery now reference it, so columns from the referenced tables appear in datatables. If the CLI output reports the table has no foreign keys, relay that no JOIN was applied.
- For each file that was updated, the previous version of the file was renamed to '<filename>.archive.NNN' (NNN is a sequential number, starting at 001) in the same payload directory. Mention this to the user in plain language so they know the old version is still on disk and available for manual rollback if needed. If the CLI output lists specific archive filenames, you may relay them to the user.
- Important: warn the user that any module or endpoint that was previously generated from the older payload still reflects the old schema. To bring those endpoints in line with the new schema, the user needs to regenerate the endpoint code from the updated payload as a follow-up step. Describe this in plain language; do not name the internal tool.
- If no files were synced (every file was SKIPPED because it was already in sync), confirm in plain language that the payload files already match the database and no changes were applied.
- Keep the reply concise. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
