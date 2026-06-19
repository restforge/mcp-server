import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenDbschemaModels(server: McpServer): void {
  server.registerTool(
    'codegen_dbschema_models',
    {
      title: 'List dbschema-kit Models',
      description: `List all schema models from dbschema-kit definition files with a structural summary (schema, table, fields count, primary key kind, indexes, uniques, relations) by wrapping restforge schema models. Output is a tabular text report. Cross-model validation is intentionally skipped so the listing is usable even when FK references are broken.

USE WHEN:
- The user asks to list models, "tampilkan semua model schema", "what tables are defined in dbschema"
- Pertanyaan dalam bentuk: "berapa banyak model di project ini", "list dbschema models", "show model summary", "ringkasan schema saya"
- Before invoking 'codegen_dbschema_generate_ddl' — to confirm the scope (which tables will be generated)
- After 'codegen_dbschema_introspect' — to verify what was generated from the live database
- The user wants a quick overview of schema-as-code state without a full validation pass
- The user asks "apa saja table yang akan di-generate ke DDL"
- Cross-check after editing the schema folder structure

DO NOT USE FOR:
- Listing live database tables -> use 'codegen_list_tables'
- Detailed inspection of a single model — use 'codegen_dbschema_validate' for correctness, or read the file directly with the Read tool
- Generating DDL -> use 'codegen_dbschema_generate_ddl'
- Looking up schema syntax -> use 'codegen_get_dbschema_catalog'

This tool runs: npx restforge schema models --schema-path=<path> in the given cwd.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The schema path must exist. If the CLI fails because the folder is missing, the failure response surfaces the underlying cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "list the schema models", "validate the schema", "generate the DDL").
- Speak in plain language. Summarise the result (model count, schemas in use); do not paste the tabular output verbatim if many models are listed.
- Models listing skips cross-model validation. If FK references are broken, listing still works; that is by design — use the validate action for correctness check.
- The user must specify --schema-path (e.g. './schema'). The CLI no longer accepts a positional argument or default. If the user does not mention a path, confirm it before invoking.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform)'),
        schemaPath: z
          .string()
          .min(1)
          .describe('Path to schema folder relative to cwd (e.g. "./schema"). Required by the CLI.'),
      },
      annotations: {
        title: 'List dbschema-kit Models',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, schemaPath }) => {
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

For the assistant:
- The user needs to install the RESTForge package before models can be listed.
- Suggest installing the package first, then retry listing the models.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // CLI v4+ requires --schema-path as a flag (no positional, no default). per §3.5
      const cliArgs = ['restforge', 'schema', 'models', `--schema-path=${schemaPath}`];

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
              text: `Failed to list schema models.

Project path: ${projectCwd}
Schema path: ${schemaPath}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that listing the schema models did not complete successfully.
- Summarise the most likely cause from the CLI output in plain language. Common causes:
  * Schema folder not found — the CLI cannot locate the path. Suggest verifying the folder name passed via --schema-path.
  * Missing required flag --schema-path — the CLI now requires this flag explicitly. Confirm the path with the user.
  * Single-model parse error — a file has invalid factory function content. Suggest opening the file and confirming it exports a defineModel call. The validate action surfaces field-level errors more precisely.
  * Unknown command 'schema models' — the installed RESTForge version may be older than this CLI subcommand; suggest upgrading the package.
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Branch B: success — labeled facts + fenced raw output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Schema models listed successfully.

Project path: ${projectCwd}
Schema path: ${schemaPath}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm to the user that the models were listed. Read the tabular output above and summarise in plain language: total model count, distinct schemas in use, any models with relations.
- Do not paste the entire tabular output if there are many models. Group by schema or list only the models relevant to the user's task.
- This listing skips cross-model validation. If the user wants to confirm FK target validity, suggest running the validation action next (without naming the internal tool).
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
