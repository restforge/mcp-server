import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenGetDashboardCatalog(server: McpServer): void {
  server.registerTool(
    'codegen_get_dashboard_catalog',
    {
      title: 'Get Dashboard Catalog',
      description: `Get authoritative JSON catalog of dashboard payload spec (payload shape with discriminator, widget structure with mutex \`query\`/\`queries\`, params contract with allowed types, scalar collapse rules, naming convention with \`dash-\` prefix, URL pattern \`POST /api/{project}/{name}/dashboard\`, file reference convention, placeholder convention with \`:paramName\`).

USE WHEN:
- The user asks about dashboard payload structure, widget definition, or how dashboard endpoints work
- The user mentions specific dashboard concepts: \`widgets\`, \`params\`, \`query\` vs \`queries\`, scalar collapse, dashboard prefix \`dash-\`
- Pertanyaan dalam bentuk seperti "bagaimana struktur payload dashboard", "apa beda dashboard dengan endpoint biasa", "kapan pakai query vs queries", "kenapa nama dashboard harus pakai dash-"
- The user asks about the URL pattern for dashboard endpoints (\`POST /api/{project}/{name}/dashboard\`)
- The user asks why dashboard names must start with \`dash-\` prefix
- The user asks about response shape: when is value a scalar, when is it object, when is it array (scalar collapse rules)
- The user asks about placeholder \`:paramName\` in widget SQL — declaration requirements, escaping (\`::\` Postgres cast)
- Before authoring a dashboard payload manually (via Write tool) — to ground field naming, allowed/forbidden fields, widget structure
- Before invoking 'codegen_validate_dashboard_payload' or 'codegen_create_dashboard' — to verify payload conforms to schema
- The user is unsure whether their use case is a dashboard or a CRUD endpoint

DO NOT USE FOR:
- Validating an actual dashboard payload file -> use 'codegen_validate_dashboard_payload'
- Generating a dashboard module from a payload -> use 'codegen_create_dashboard'
- Looking up CRUD payload field validation rules -> use 'codegen_get_field_validation_catalog'
- Looking up CRUD query declarative spec (\`datatablesQuery\`, \`viewQuery\`, \`viewName\`, \`exportQuery\`, \`detailQuery\`) -> use 'codegen_get_query_declarative_catalog'
- Generating a CRUD payload from a database table -> use 'codegen_generate_payload'
- Validating CRUD payload drift against the database -> use 'codegen_validate_payload'
- Common widget patterns examples (Metric+Donut, Metric+Sparkline, Metric+Goal) — not in catalog scope; refer to the documentationUrl returned in the response
- Frontend integration examples (Metronic, AdminLTE, etc.) — not in catalog scope; refer to documentationUrl
- Separation of Concerns rationale for forbidden frontend fields — not in catalog scope; refer to documentationUrl
- Multi-database SQL dialect adaptation inside widget queries — not in catalog scope; refer to documentationUrl
- Performance characteristics (Promise.allSettled execution, in-memory SQL embedding) — not in catalog scope; refer to documentationUrl

This tool runs: npx restforge dashboard:catalog in the given cwd.
The catalog is sourced from restforge (single source of truth) so it stays in sync with
the restforge runtime version installed in the project.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "look up the dashboard catalog", "edit the dashboard payload", "install the package").
- Speak in plain language. Summarise the catalog (number of allowed top-level fields, forbidden frontend fields, param types, scalar collapse rules); do not paste the entire JSON unless the user explicitly asks for it.
- When the user is unsure whether their use case is dashboard or CRUD, briefly explain the discriminator: \`widgets\` array means dashboard (multi-query aggregator), \`tableName\` means CRUD (single-table REST endpoint). They cannot mix.
- When a precondition is not met (e.g. the package is not installed), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform)'),
      },
      annotations: {
        title: 'Get Dashboard Catalog',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd }) => {
      const projectCwd = resolve(cwd);

      // Precondition check: @restforgejs/platform must be installed before this CLI command can run.
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

For the assistant:
- The dashboard catalog can only be retrieved once the RESTForge package is installed locally.
- Suggest installing the package first, then retry getting the catalog.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Run subprocess with NODE_ENV=production to suppress legacy banner output
      // (mirrors the pattern used by setup_get_config_schema and other catalog tools).
      const result = await execProcess(
        'npx',
        ['restforge', 'catalog', 'dashboard'],
        {
          cwd: projectCwd,
          timeout: 15_000,
          env: { NODE_ENV: 'production' },
          stripFinalNewline: true,
        }
      );

      // CLI failure: real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to retrieve the dashboard catalog.

Project path: ${projectCwd}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that the dashboard catalog could not be retrieved.
- A common cause is an older RESTForge version that does not yet expose this command. If the CLI output mentions an unknown command, suggest upgrading the package as a likely fix.
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Validate JSON output. Parse failure is a real error per §3.4 (CLI succeeded but produced invalid output).
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to parse dashboard catalog JSON.

Project path: ${projectCwd}
Reason: ${msg}

--- Raw stdout ---
${result.stdout}
--- end Raw stdout ---

For the assistant:
- The CLI returned output that is not valid JSON.
- Summarise this to the user in plain language; do not paste the raw stdout unless they explicitly ask.
- Suggest checking that the installed package version is compatible. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Extract summary counts for labeled facts. Use defensive access — if the catalog shape
      // changes upstream, we still produce a sensible response rather than crash.
      const root = (parsed ?? {}) as Record<string, unknown>;
      const summary = (root.summary ?? {}) as Record<string, unknown>;
      const totalAllowedTopLevelFields =
        typeof summary.totalAllowedTopLevelFields === 'number'
          ? summary.totalAllowedTopLevelFields
          : 'unknown';
      const totalForbiddenFrontendFields =
        typeof summary.totalForbiddenFrontendFields === 'number'
          ? summary.totalForbiddenFrontendFields
          : 'unknown';
      const totalParamTypes =
        typeof summary.totalParamTypes === 'number' ? summary.totalParamTypes : 'unknown';
      const totalScalarCollapseRules =
        typeof summary.totalScalarCollapseRules === 'number'
          ? summary.totalScalarCollapseRules
          : 'unknown';
      const sourceLabel = typeof root.source === 'string' ? root.source : 'dashboard-catalog';

      // Re-stringify for consistent pretty formatting (independent of CLI --pretty flag).
      const prettyJson = JSON.stringify(parsed, null, 2);

      // Success: one-line summary + labeled facts + fenced JSON output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Dashboard catalog retrieved successfully.

Project path: ${projectCwd}
Source: restforge (${sourceLabel}) — single source of truth for the installed runtime version
totalAllowedTopLevelFields: ${totalAllowedTopLevelFields}
totalForbiddenFrontendFields: ${totalForbiddenFrontendFields}
totalParamTypes: ${totalParamTypes}
totalScalarCollapseRules: ${totalScalarCollapseRules}

--- Dashboard Catalog (JSON) ---
${prettyJson}
--- end Dashboard Catalog (JSON) ---

For the assistant:
- Confirm to the user that the catalog is available. Summarise in plain language: how many allowed top-level fields, forbidden frontend fields, param types, and scalar collapse rules are included.
- Do not paste the full JSON block unless the user explicitly asks for it. If the user only asked to "see the catalog", offer to drill into a specific aspect (widget structure, params contract, naming convention, scalar collapse rules) instead of dumping everything.
- Use this catalog as ground truth when the user is:
  * Asking "how is a dashboard payload structured?"
  * Authoring a dashboard payload manually (via the Write tool)
  * Confused between dashboard payload (\`widgets\`) and CRUD payload (\`tableName\`)
  * Asking about the \`dash-\` prefix in dashboard names
  * Asking when to use \`query\` vs \`queries\`
  * Asking about response shape (scalar collapse rules)
  * Asking about \`:paramName\` placeholders in widget SQL
- Filter notes for catalog consumers (avoid common pitfalls):
  * \`payloadShape.discriminator\` is the way to tell whether a payload is a dashboard or a CRUD endpoint. \`widgets\` present means dashboard. \`tableName\` present means CRUD. A payload with both is rejected by the validator.
  * \`widgetSpec.exclusiveQueryFields\` is a mutex rule: every widget MUST declare exactly one of \`query\` (singular, response always wraps as \`{ items: [...] }\`) OR \`queries\` (object, per-key shape determined by scalar collapse rules). Both or neither is rejected.
  * \`paramSpec.perEntryFields[0].allowedValues\` is a closed enum of four values: \`string\`, \`number\`, \`boolean\`, \`date\`. Other type strings are rejected by the validator.
  * \`scalarCollapseRules\` apply ONLY to \`widget.queries.<key>\`. For \`widget.query\` (singular) the response is ALWAYS wrapped as \`{ items: [...] }\` regardless of SQL result shape.
  * \`namingConvention.dashboardName.regex\` is \`^dash-[a-zA-Z0-9_-]+$\`. minLength is 6 because \`dash-\` is 5 characters and at least one suffix character is required.
  * \`placeholderConvention.regex\` uses a negative lookbehind \`(?<!:):\` so Postgres cast syntax \`::\` is NOT scanned as a placeholder. Every placeholder used in widget SQL must be declared in the top-level \`params\` object, otherwise the validator rejects the payload.
- Knowledge boundary — the catalog does NOT cover the following; refer the user to \`documentationUrl\` (in the response JSON) instead of fabricating from training data:
  * Common widget patterns with concrete SQL examples (Metric+Donut, Metric+Sparkline, Metric+Goal).
  * Frontend mapping examples — how the response is rendered in Metronic, AdminLTE, or other UI frameworks.
  * Separation of Concerns rationale for the forbidden frontend fields (\`widgetType\`, \`layout\`, \`title\`, \`subtitle\`, \`color\`).
  * Multi-database SQL dialect adaptation inside widget queries.
  * Performance characteristics (Promise.allSettled execution, in-memory SQL embedding, zero disk I/O at request time).
- Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
