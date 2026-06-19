import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenGetFieldValidationCatalog(server: McpServer): void {
  server.registerTool(
    'codegen_get_field_validation_catalog',
    {
      title: 'Get Field Validation Catalog',
      description: `Get authoritative JSON catalog of field validation spec (data types, constraints, format presets, audit columns convention, message override pattern) used in payload \`fieldValidation\` arrays.

USE WHEN:
- The user asks about valid field validation constraints, types, format presets, or audit columns convention in payload JSON
- The user asks things like "constraint apa yang valid untuk tipe X", "list field validation constraints", "tampilkan catalog validasi", "what validation rules can I use", "format preset apa saja", "show me the validation spec"
- Before generating or editing the \`fieldValidation\` array in a payload file — to ground constraint names, scope correctness, and the message override pattern. Often called before 'codegen_generate_payload' for grounding the initial generation, or before manual editing of an existing payload.
- The user mentions adding validation to a payload field but is unsure which constraint name to use
- The user asks about audit columns convention (\`auditColumns: false\`, override custom names, valid/rejected values, etc.)
- The user asks about the message override pattern (\`{constraintName}Message\`)
- The user reports a typo-like error such as \`maxLenght\` or wonders whether \`minLength\` works on a number field — fetch the catalog to ground the answer
- The user wants to add validation rules at APPLICATION LAYER in payload JSON (validation runs in generated model code, returns HTTP 400 with structured error before the request reaches the database), NOT native SQL DDL constraints (NOT NULL, UNIQUE, CHECK at database level)

DO NOT USE FOR:
- Validating actual payload files against the database schema -> use 'codegen_validate_payload'
- Validating config (license, database connection) -> use 'setup_validate_config'
- Reading the active database connection config schema -> use 'setup_get_config_schema'
- Generating a payload from scratch -> use 'codegen_generate_payload'
- Applying changes to payload files -> use 'codegen_sync_payload'
- Generating SQL DDL constraints (NOT NULL, UNIQUE, CHECK, REFERENCES, ALTER TABLE, CREATE INDEX) — these are database-level and out of scope for RESTForge field validation. They require direct SQL or a database migration tool.

This tool runs: npx restforge field-validation:catalog in the given cwd.
The catalog is sourced from restforge (single source of truth) so it stays in sync with
the restforge runtime version installed in the project.
Requires @restforgejs/platform >= 2.4.0.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "install the package", "generate the payload", "edit the validation rules").
- Speak in plain language. Summarise the catalog (number of types, constraints, format presets); do not paste the entire JSON unless the user explicitly asks for it.
- If the user uses SQL DDL terminology (NOT NULL, UNIQUE, CHECK, ALTER TABLE, REFERENCES, CREATE INDEX), do not silently map it to payload validation. First clarify which layer the user wants: application-layer validation in payload (this catalog applies, response 400 with structured error) versus database-level DDL constraints (out of scope here, requires direct SQL or migration tool). The two layers can co-exist for the same field but behave differently.
- When a precondition is not met (e.g. the package is not installed), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform, version >= 2.4.0)'),
      },
      annotations: {
        title: 'Get Field Validation Catalog',
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
- The field validation catalog can only be retrieved once the RESTForge package is installed locally.
- Suggest installing the package first, then retry getting the catalog.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Run subprocess with NODE_ENV=production to suppress legacy banner output
      // (mirrors the pattern used by setup_get_config_schema).
      const result = await execProcess(
        'npx',
        ['restforge', 'catalog', 'field-validation'],
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
              text: `Failed to retrieve the field validation catalog.

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
- Tell the user that the field validation catalog could not be retrieved.
- A common cause is an older RESTForge version that does not yet expose this command (requires @restforgejs/platform >= 2.4.0). If the CLI output mentions an unknown command, suggest upgrading the package as a likely fix.
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
              text: `Failed to parse field validation catalog JSON.

Project path: ${projectCwd}
Reason: ${msg}

--- Raw stdout ---
${result.stdout}
--- end Raw stdout ---

For the assistant:
- The CLI returned output that is not valid JSON.
- Summarise this to the user in plain language; do not paste the raw stdout unless they explicitly ask.
- Suggest checking that the installed package version is compatible (requires @restforgejs/platform >= 2.4.0). Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Extract summary counts for labeled facts. Use defensive access — if the catalog shape
      // changes upstream, we still produce a sensible response rather than crash.
      const root = (parsed ?? {}) as Record<string, unknown>;
      const summary = (root.summary ?? {}) as Record<string, unknown>;
      const totalTypes = typeof summary.totalTypes === 'number' ? summary.totalTypes : 'unknown';
      const totalConstraints = typeof summary.totalConstraints === 'number' ? summary.totalConstraints : 'unknown';
      const totalFormatPresets = typeof summary.totalFormatPresets === 'number' ? summary.totalFormatPresets : 'unknown';
      const sourceLabel = typeof root.source === 'string' ? root.source : 'field-validation-catalog';

      // Re-stringify for consistent pretty formatting (independent of CLI --pretty flag).
      const prettyJson = JSON.stringify(parsed, null, 2);

      // Success: one-line summary + labeled facts + fenced JSON output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Field validation catalog retrieved successfully.

Project path: ${projectCwd}
Source: restforge (${sourceLabel}) — single source of truth for the installed runtime version
totalTypes: ${totalTypes}
totalConstraints: ${totalConstraints}
totalFormatPresets: ${totalFormatPresets}

--- Field Validation Catalog (JSON) ---
${prettyJson}
--- end Field Validation Catalog (JSON) ---

For the assistant:
- Confirm to the user that the catalog is available. Summarise in plain language: how many data types, constraints, and format presets are included.
- Do not paste the full JSON block unless the user explicitly asks for it. If the user only asked to "see the catalog", offer to drill into a specific type or constraint instead of dumping everything.
- When the user is generating or editing a payload's \`fieldValidation\` array, use this catalog as ground truth to:
  * Validate constraint names spelling (e.g. reject typos like \`maxLenght\`).
  * Validate scope correctness (e.g. \`minLength\` is only valid for type \`string\`, not \`number\`). Use each type's \`applicableConstraints\` list as the shortcut for "which constraints are valid for type X" without iterating the full constraints array.
  * Suggest constraints that fit the column's database type (e.g. CHAR/VARCHAR -> \`maxLength\`, \`pattern\`; INT/BIGINT -> \`min\`, \`max\`, \`positive\`).
- Filter notes to disambiguate name collisions in the catalog:
  * \`format\` constraint appears twice — scope=\`string\` (format presets such as email/phone/url/uuid) and scope=\`date\` (date format pattern). Filter by \`name + scope\` or \`name + applicableTypes\` to pick the right one.
  * \`integer\` appears twice — once as a data type (\`types[].name === "integer"\`) and once as a number constraint (\`constraints[].name === "integer"\` with scope \`number\`). Disambiguate by context.
  * \`uuid\` appears twice — once as a data type (\`VARCHAR(36)\` field type) and once as a format preset (validator format string). Choose by what the user is trying to express.
- Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
