import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function registerCodegenCreateDashboard(server: McpServer): void {
  server.registerTool(
    'codegen_create_dashboard',
    {
      title: 'Create Dashboard Module',
      description: `Generate a multi-widget dashboard endpoint module from a payload spec by wrapping restforge dashboard. URL pattern produced: POST /api/{project}/{name}/dashboard.

Dashboards differ structurally from CRUD endpoints: there is no table, no fieldValidation, no CRUD actions. The payload declares a 'widgets' array — each widget owns SQL aggregation queries that are embedded into the generated module file and executed in parallel at request time, returning a JSON envelope keyed by widget id.

This tool is DESTRUCTIVE: it spawns the CLI which writes / overwrites files in 'src/modules/<project>.js' and 'src/modules/<project>/<name>.js', plus 'metadata/<project>/<name>.json' and updates '.restforge/projects.json'. Single-call semantics: the tool always executes; there is no preview mode. Internally the tool always passes '--force=true' to the CLI to bypass the CLI's interactive y/N readline prompt (which would deadlock in a no-TTY subprocess).

Safety net: when the CLI overwrites an existing dashboard module, it FIRST renames the previous version to '<name>.archive.NNN' (NNN is a sequential generation number starting at 001) inside the same folder. Rollback by restoring the most recent archive is always possible.

AI responsibility — IMPORTANT: because this tool always executes and may overwrite generated files, you MUST confirm intent with the user in plain language BEFORE invoking the tool. You do NOT need to detect file conflicts programmatically — the CLI handles that and the archive mechanism keeps the previous version safe. Just confirm intent. Examples of good confirmation phrasing in user-facing chat:
- "Saya akan generate dashboard <name> di project <project>. Kalau modul lama sudah ada, versi sebelumnya akan disimpan sebagai '.archive.NNN'. Lanjut?"
- "I will generate <name> under project <project>. Existing files will be archived as .archive.NNN before being overwritten. Proceed?"

USE WHEN:
- The user asks to generate, create, or scaffold a dashboard endpoint, multi-widget aggregator, or analytics endpoint (e.g. "buatkan dashboard X di project Y", "generate dashboard sales", "scaffold dashboard inbound dengan payload Z")
- The user mentions "dashboard", "widget aggregator", "multi-widget", "POST .../dashboard", or terms like "donut breakdown", "metric card", "sparkline" in the context of generating an endpoint
- The user has authored a payload file with a 'widgets' array (not a CRUD 'tableName' shape) and wants to materialise it as a runnable endpoint
- Pertanyaan dalam bentuk: "buatkan dashboard X di project Y", "generate dashboard sales", "scaffold dashboard inbound dengan payload Z"
- The user mentions the URL pattern POST /api/<project>/<name>/dashboard and wants to register it as runnable code
- The user explicitly references dashboard concepts: scalar collapse rules, widget id, query versus queries, params contract, file:query/*.sql references inside widgets
- After 'codegen_validate_payload' confirmed a dashboard-shape payload — this is the natural follow-up that turns it into runnable code
- The user asks to regenerate an existing dashboard after the payload changed (overwrite + archive flow handled by the CLI)

DO NOT USE FOR:
- Generating a CRUD endpoint (payload has 'tableName', 'fieldName', 'action') -> use 'codegen_create_endpoint'
- Generating the payload JSON itself from a database table -> use 'codegen_generate_payload' (note: codegen_generate_payload targets CRUD payloads — dashboard payloads are typically authored manually)
- Validating a payload before generation -> use 'codegen_validate_payload'
- Inspecting per-column differences between payload and database -> use 'codegen_diff_payload'
- Syncing payload changes back into existing payload files after schema drift -> use 'codegen_sync_payload'
- Looking up the field validation catalog (dashboards do not have field validation) -> use 'codegen_get_field_validation_catalog' only if discussing CRUD payload fields
- Looking up the query declarative catalog (dashboards have their own query structure with widgets[].query and widgets[].queries) -> use 'codegen_get_query_declarative_catalog' only if discussing CRUD payload queries
- Generating a processor (Kafka consumer, etc.) — out of scope; the CLI has separate 'processor' subcommand not covered by this MCP server yet
- Deleting a dashboard or project — out of scope; the user must run 'npx restforge drop' manually
- Changing widget visual presentation (widgetType, layout, color, title, subtitle) — those are frontend concerns and forbidden in the dashboard payload (separation of concerns); they belong in the frontend code, not in this generator

Cross-reference: this tool is sibling of 'codegen_create_endpoint'. Both generate runnable code from payload JSON, but they consume different payload shapes (CRUD vs dashboard) and produce different artefacts (full module + model vs single dashboard module with embedded SQL).

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The payload file must exist at <cwd>/payload/<payload>.json before calling this tool.
- The payload must follow the dashboard schema: a 'widgets' array (NOT a CRUD payload with 'tableName'). The CLI's DashboardValidator rejects payloads that mix shapes, declare forbidden frontend fields (widgetType, layout, title, subtitle, color), have widgets without 'id', have duplicate widget ids, declare both 'query' AND 'queries' in the same widget, declare neither, or use placeholders not declared in 'params'.
- The dashboard name MUST start with 'dash-' prefix (e.g. dash-sales, dash-inbound). The prefix is required by the CLI and becomes part of the URL segment.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "the dashboard generator", "validate the payload first", "draft the payload first").
- Speak in plain language. Summarise the result; do not paste raw CLI output unless the user explicitly asks.
- This tool is destructive: it can overwrite an existing dashboard module file. BEFORE invoking this tool, ALWAYS confirm with the user in plain language. Example: "Saya akan generate dashboard <name> di project <project>. Kalau modul lama sudah ada, akan ditimpa (versi sebelumnya disimpan sebagai .archive.NNN). Lanjut?". Do not detect conflicts programmatically; the CLI handles that and creates the archive.
- After the tool runs, summarise the result. Surface the resulting endpoint URL (POST /api/<project>/<name>/dashboard) so the user knows where to call it. Read the CLI output and identify any archive activity using the '.archive.NNN' filesystem convention; surface to the user when archives exist.
- If the user is confused about the difference between a dashboard and a CRUD endpoint: dashboards aggregate data from multiple SQL queries (widgets) and return a JSON envelope with widget keys; CRUD endpoints expose actions like /datatables, /read, /create, /update, /delete on a single table. Suggest the right tool based on what the user is actually building.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform and a payload/ directory with the named payload file)'),
        project: z
          .string()
          .min(1)
          .max(50)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'must start with a letter or number; only letters, numbers, dashes, underscores allowed')
          .describe('Project name. Letters/numbers/dash/underscore, max 50 chars, cannot start or end with dash or underscore. Auto-lowercased by the CLI. Reserved names rejected by the CLI: src, lib, node_modules, config, utils, models, controllers, middleware, routes.'),
        name: z
          .string()
          .min(6)
          .max(50)
          .regex(/^dash-[a-zA-Z0-9_-]+$/, "must start with 'dash-' prefix and have at least one character after it (e.g. dash-sales, dash-inbound)")
          .describe("Dashboard name. MUST start with 'dash-' prefix. The prefix is required by the CLI and becomes part of the URL segment (POST /api/{project}/{name}/dashboard). The full name is the URL slug, e.g. dash-sales, dash-inbound. The CLI rejects 'dash-' alone — there must be at least one character after the prefix."),
        payload: z
          .string()
          .min(1)
          .max(50)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'must start with a letter or number; only letters, numbers, dashes, underscores allowed')
          .describe('Payload file name without the .json extension. The file must exist at <cwd>/payload/<payload>.json. Payload must follow the dashboard schema (with a `widgets` array; NOT a CRUD payload with `tableName`).'),
        database: z
          .enum(['postgres', 'oracle', 'mysql'])
          .optional()
          .describe('Database type for the generated code. Default postgres.'),
        skipSqlValidation: z
          .boolean()
          .optional()
          .describe('Default false (CLI default). When true, skip SQL keyword validation in payload widget queries. Useful when the SQL fragments are intentional but the validator flags them as suspicious.'),
      },
      annotations: {
        title: 'Create Dashboard Module',
        readOnlyHint: false,    // tool spawns CLI that writes module/metadata files and updates the registry
        destructiveHint: true,  // can overwrite an existing dashboard module file (CLI archives it as .archive.NNN first)
        idempotentHint: false,  // re-running creates new archive files
      },
    },
    async ({ cwd, project, name, payload, database, skipSqlValidation }) => {
      const projectCwd = resolve(cwd);
      const dbType = database ?? 'postgres';

      // Pre-flight 1: @restforgejs/platform must be installed. Treated as a non-error precondition per §3.4.
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
Requested project: ${project}
Requested dashboard: ${name}
Requested payload: ${payload}
Requested database: ${dbType}

For the assistant:
- The dashboard generator can only run once the RESTForge package is installed locally.
- Suggest installing the package first, then retry generating the dashboard.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Pre-flight 2: payload file must exist. Treated as a non-error precondition per §3.4.
      const payloadPath = join(projectCwd, 'payload', `${payload}.json`);
      if (!(await pathExists(payloadPath))) {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: payload file not found.

Project path: ${projectCwd}
Expected payload file: ${payloadPath}
Requested project: ${project}
Requested dashboard: ${name}
Requested database: ${dbType}

For the assistant:
- The dashboard generator needs the payload file to exist before it can run.
- Suggest creating or locating the payload first. Dashboard payloads have a different schema than CRUD payloads (a \`widgets\` array instead of \`tableName\`); see the dashboard documentation if the user is unfamiliar with the format.
- When explaining to the user, say something like "the payload file '${payload}.json' isn't in the payload/ folder yet — should I help you draft it, or do you have one to put there?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Build CLI invocation. --force=true is hardcoded: it bypasses the interactive readline
      // prompt that would otherwise deadlock the subprocess. Conflict detection and archive
      // creation are delegated to the CLI (single source of truth — see refactor 8C).
      const cliArgs = [
        'restforge',
        'dashboard',
        'create',
        `--project=${project}`,
        `--name=${name}`,
        `--payload=${payload}`,
        `--database=${dbType}`,
        '--force=true',
      ];
      if (skipSqlValidation !== undefined) cliArgs.push(`--skip-sql-validation=${skipSqlValidation}`);

      const result = await execProcess(
        'npx',
        cliArgs,
        {
          cwd: projectCwd,
          timeout: 60_000,
          env: { NODE_ENV: 'production' }, // suppress legacy banner output
          stripFinalNewline: true,
        }
      );

      // Branch C: CLI failure — real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to create the dashboard module.

Project path: ${projectCwd}
Project: ${project}
Dashboard: ${name}
Payload: payload/${payload}.json
Database: ${dbType}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that creating the dashboard module did not complete successfully.
- Summarise the most likely cause from the CLI output in plain language. Common causes:
  * Dashboard name did not start with 'dash-' prefix — suggest renaming (e.g. 'sales' becomes 'dash-sales').
  * Payload uses CRUD shape (has 'tableName') instead of dashboard shape (has 'widgets') — suggest reviewing the payload structure or pointing to dashboard documentation.
  * Payload contains forbidden frontend fields (widgetType, layout, title, subtitle, color) — those are frontend concerns and must be removed.
  * Widget without 'id', duplicate widget id, or widget that declares both 'query' AND 'queries' (or neither) — suggest reviewing the widgets array.
  * Widget SQL uses an undeclared placeholder (e.g. ':year' but 'year' missing from 'params') — suggest declaring the missing param or removing the placeholder.
  * Database mismatch with the existing project registry entry — the CLI refuses to switch the database. Suggest sticking with the originally registered database.
  * Reserved project name rejected by the validator — suggest a different project name.
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.
- Offer to retry once the underlying issue is resolved.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Branch B: CLI success — one-line summary + labeled facts + fenced output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Dashboard module created successfully.

Project path: ${projectCwd}
Project: ${project}
Dashboard: ${name}
Payload: payload/${payload}.json
Database: ${dbType}
Endpoint: POST /api/${project}/${name}/dashboard

Generated artefacts (commonly produced by the CLI):
- src/modules/${project}.js (main module — created or refreshed)
- src/modules/${project}/${name}.js (dashboard handler with embedded SQL)
- metadata/${project}/${name}.json (dashboard metadata)
- .restforge/projects.json (registry update)

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm to the user in plain language that the dashboard endpoint was generated. Mention the project, dashboard name, and the resulting URL: POST /api/${project}/${name}/dashboard.
- Do not paste the entire CLI output unless the user explicitly asks; summarise instead.
- Read the CLI output to identify any archive activity (the CLI uses the '.archive.NNN' naming convention in the filesystem and reports archive activity in its output, but the exact phrasing may evolve). When archives are created, tell the user that the previous version of the dashboard module is preserved in case rollback is needed.
- Suggest natural follow-up actions appropriate to context: review the generated module, run the project to test the new dashboard endpoint, draft a frontend caller, etc. Do not mention internal tool names.
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
