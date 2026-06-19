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

export function registerCodegenValidateDashboardPayload(server: McpServer): void {
  server.registerTool(
    'codegen_validate_dashboard_payload',
    {
      title: 'Validate Dashboard Payload',
      description: `Validate the structural correctness of a dashboard payload spec WITHOUT generating any file, by wrapping restforge dashboard --validate-only=true.

Dashboards have a different shape than CRUD endpoints (widgets array, no tableName, no fieldValidation). The CLI's DashboardValidator checks: widgets array shape, allowed/forbidden fields per level, the 'query' vs 'queries' mutual exclusion, params contract (each ':placeholder' used in SQL must be declared in 'params'), 'file:query/<name>.sql' reference resolution, and that no frontend-only fields (widgetType, layout, title, subtitle, color) leak into the payload.

This tool is READ-ONLY: it does NOT write any file, does NOT touch the database, does NOT update the project registry. It only reports whether the payload structure is valid. Re-running with the same input gives the same result (idempotent).

Workflow positioning: this is the natural pre-flight before 'codegen_create_dashboard'. When the AI authors a dashboard payload (manually via Write), call this tool first to surface validation errors cheaply — before invoking the generator that performs filesystem writes.

Gap closed: the general 'codegen_validate_payload' tool silently skips dashboard payloads (it filters on 'tableName' and 'fieldName'). This tool fills that gap for the dashboard shape.

USE WHEN:
- The user asks to validate, check, or verify the structure of a dashboard payload before generating
- The user has authored a dashboard payload (with 'widgets' array) and wants to confirm it parses correctly before invoking the generator
- Pertanyaan dalam bentuk: "cek dashboard payload saya valid?", "validate dashboard config", "is this dashboard schema correct?", "apakah payload dashboard ini OK?"
- Before invoking 'codegen_create_dashboard' — pre-flight to surface validation errors early (cheaper than failing inside the generator stage, which performs filesystem writes)
- The user reports that 'codegen_create_dashboard' failed with a validation-related error and wants to fix the payload iteratively
- The user mentions specific dashboard validation rules: forbidden frontend fields (widgetType, layout, title, subtitle, color), 'query' vs 'queries' mutex, params placeholder declaration
- After the user manually edited a dashboard payload and wants a quick sanity check before re-running the generator
- The user is unsure whether their payload follows dashboard shape (widgets) or CRUD shape (tableName) and wants verification

DO NOT USE FOR:
- Validating a CRUD payload (with 'tableName' and 'fieldName') against database schema -> use 'codegen_validate_payload'
- Generating the dashboard module after validation -> use 'codegen_create_dashboard'
- Inspecting drift between CRUD payload and database -> use 'codegen_validate_payload' (this dashboard validator does NOT touch the database)
- Generating a payload from scratch -> use 'codegen_generate_payload' for CRUD; for dashboard, the user authors manually
- Looking up the field validation catalog -> use 'codegen_get_field_validation_catalog' (different scope; dashboard payloads have no fieldValidation)
- Validating SQL syntax inside a widget query — the validator only checks placeholder declarations and structural shape, not SQL semantics. SQL errors will only surface when the dashboard endpoint is actually called at runtime.

Cross-reference: this tool is the read-only sibling of 'codegen_create_dashboard'. Both have nearly identical input schemas, but this tool only validates and does NOT generate any file.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The payload file must exist at <cwd>/payload/<payload>.json before calling this tool.
- The dashboard name MUST start with 'dash-' prefix (CLI requirement). For validate-only mode, this is checked at the argument-parser level even though the value is not used to write any file.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "validate the dashboard payload", "generate the dashboard module").
- Speak in plain language. Summarise the result; do not paste raw CLI output unless the user explicitly asks.
- This tool is read-only: it validates payload structure without writing files or touching the database. Safe to invoke proactively before 'codegen_create_dashboard' to give the user faster feedback on payload errors.
- If validation passes, briefly confirm the result and offer to proceed with generation. If validation fails, surface the specific error in plain language and offer to help fix it. Do not paste raw CLI output unless the user explicitly asks.
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
          .describe('Project name. Required by the CLI argument schema even in validate-only mode. Letters/numbers/dash/underscore, max 50 chars.'),
        name: z
          .string()
          .min(6)
          .max(50)
          .regex(/^dash-[a-zA-Z0-9_-]+$/, "must start with 'dash-' prefix and have at least one character after it (e.g. dash-sales, dash-inbound)")
          .describe("Dashboard name. MUST start with 'dash-' prefix (CLI requirement). For validate-only mode, this is checked at the argument-parser level even though the value is not used to write any file. The CLI rejects 'dash-' alone — there must be at least one character after the prefix."),
        payload: z
          .string()
          .min(1)
          .max(50)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'must start with a letter or number; only letters, numbers, dashes, underscores allowed')
          .describe('Payload file name without the .json extension. The file must exist at <cwd>/payload/<payload>.json. Payload must follow the dashboard schema (with a `widgets` array; NOT a CRUD payload with `tableName`).'),
        database: z
          .enum(['postgres', 'oracle', 'mysql'])
          .optional()
          .describe('Database type. Default postgres. Database connection is NOT used in validate-only mode (validation is structural, not drift-based), but kept for argument-schema parity with codegen_create_dashboard.'),
        skipSqlValidation: z
          .boolean()
          .optional()
          .describe('Default false (CLI default). When true, skip SQL keyword validation in payload widget queries. Useful when the SQL fragments are intentional but the validator flags them as suspicious.'),
      },
      annotations: {
        title: 'Validate Dashboard Payload',
        readOnlyHint: true,    // pure validation, no filesystem write, no DB write
        idempotentHint: true,  // re-running gives same result for same input
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

For the assistant:
- The dashboard payload validator can only run once the RESTForge package is installed locally.
- Suggest installing the package first, then retry validating the dashboard payload.
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
Requested payload: ${payload}

For the assistant:
- The dashboard payload validator needs the payload file to exist before it can run.
- Suggest creating or locating the payload first. Dashboard payloads have a different schema than CRUD payloads (a \`widgets\` array instead of \`tableName\`); see the dashboard documentation if the user is unfamiliar with the format.
- When explaining to the user, say something like "the payload file '${payload}.json' isn't in the payload/ folder yet — should I help you draft it, or do you have one to put there?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Build CLI invocation. --validate-only=true is hardcoded: this tool is ONLY for validation.
      // --force is NOT passed (not relevant for validate-only — no overwrite scenario).
      // Validation logic itself is delegated to the CLI's DashboardValidator (single source of
      // truth — see refactor 8C).
      const cliArgs = [
        'restforge',
        'dashboard',
        'create',
        `--project=${project}`,
        `--name=${name}`,
        `--payload=${payload}`,
        `--database=${dbType}`,
        '--validate-only=true',
      ];
      if (skipSqlValidation !== undefined) cliArgs.push(`--skip-sql-validation=${skipSqlValidation}`);

      const result = await execProcess(
        'npx',
        cliArgs,
        {
          cwd: projectCwd,
          timeout: 30_000, // validation is light: no DB connection, no filesystem write
          env: { NODE_ENV: 'production' }, // suppress legacy banner output
          stripFinalNewline: true,
        }
      );

      // Branch C: CLI failure (validation failed or other) — real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Dashboard payload validation failed.

Project path: ${projectCwd}
Project: ${project}
Dashboard: ${name}
Payload: payload/${payload}.json
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that the dashboard payload validation did not pass. Surface the error message from the CLI output (typically a single 'Error: ...' line) in plain language.
- Common validation errors and suggested fixes:
  * 'must not contain tableName' — the payload has CRUD shape; remove 'tableName' or use the CRUD payload validator instead (do not mention internal tool name; describe the action).
  * 'must have widgets array' — payload is missing the 'widgets' field; suggest adding it with at least one entry.
  * 'must declare either query or queries' — a widget is missing both fields; pick one based on whether the widget needs single SQL or multi-SQL.
  * 'undeclared placeholder' — SQL uses ':param_name' that is not declared in 'params'; add it to 'params' or remove the placeholder from SQL.
  * 'forbidden frontend field' (widgetType, layout, title, subtitle, color) — those belong in the frontend code; remove them from the payload.
  * 'invalid type' for params — the param type must be one of: string, number, boolean, date.
  * 'duplicate widget id' — two widgets share the same id; pick distinct ids.
- Offer to help fix the payload and retry validation.
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Branch B: CLI success (validation passed) — one-line summary + labeled facts + fenced output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Dashboard payload validation passed.

Project path: ${projectCwd}
Project: ${project}
Dashboard: ${name}
Payload: payload/${payload}.json

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm to the user in plain language that the dashboard payload structure is valid.
- This validation does NOT touch the database or write any file. It only checks payload structure (widgets array shape, allowed/forbidden fields, params contract, file:reference resolution, placeholder declaration).
- If the user requested validation as a precursor to generation, the next step is to generate the dashboard module. Do not mention internal tool names; describe the action ("generate the dashboard module").
- If the CLI output mentions warnings (lines starting with '! Warning'), surface them to the user — these are non-fatal but worth knowing.
- Do not paste the full CLI output unless the user explicitly asks; summarise instead.
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
