import { z } from 'zod';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDesignerGetUdfCatalog(server: McpServer): void {
  server.registerTool(
    'designer_get_udf_catalog',
    {
      title: 'Get UDF Catalog',
      description: `Get the authoritative JSON catalog of RESTForge Designer UDF structure and rules (valid field types, editor modes, badge colors, id-generation options, navigation item types/depth limits, required appConfig fields, port range, number format, and dashboard widget/chart/data-source options), by running npx restforge-designer catalog. The catalog is serialized from the designer's own validator constants (single source of truth), so it stays in sync with the installed designer version and never drifts.

USE WHEN:
- Before composing or editing a UDF payload — to ground valid field types and required fields against the designer's own rules
- The user asks things like "tipe field UDF apa yang valid", "valid UDF field types", "struktur appConfig", "required appConfig fields", "aturan UDF designer", "enum UDF", "what badge colors are allowed", "apa yang boleh di dashboard widget", "which dashboard widgets/charts are available", "show me the UDF catalog"
- 'designer_validate_payload' rejects a UDF payload and you need the authoritative shape (allowed enum values, required fields) to fix it
- The user wants the catalog of dashboard widget types, chart engines, or data source methods for a designer UDF

DO NOT USE FOR:
- Validating a concrete UDF payload against a plugin -> use 'designer_validate_payload'
- Reading the identity/metadata or schema of ONE specific plugin -> use 'designer_inspect_plugin'
- Listing available designer plugins -> use 'designer_list_plugins'
- The BACKEND field validation catalog (RDF payload fieldValidation constraints, data types, format presets) -> use 'codegen_get_field_validation_catalog'

This tool wraps the RESTForge Designer CLI command: npx restforge-designer catalog [--section=<fields|navigation|app-config|dashboard|all>], run in the given cwd.
The catalog is a static constant (it does not depend on cwd) and the command does not modify any file and does not require a license.

Preconditions:
- RESTForge Designer is invoked via 'npx restforge-designer' (the binary is bundled with the @restforgejs/platform package). This tool pre-checks that by running
  'npx restforge-designer --version'; if it cannot run, the response surfaces that as a non-error precondition.
- The installed designer must be recent enough to support the 'catalog' command. Older designer builds do not have it; in
  that case the response surfaces a non-error precondition suggesting the designer be updated.

Cross-reference (read-before-write):
- Call this tool BEFORE authoring or editing a UDF payload, and before generating frontend code, to ground the payload shape against the designer's own rules.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "look up the UDF rules", "validate the payload", "generate the frontend code").
- Speak in plain language. Summarise the catalog (e.g. how many valid field types, which sections are present); do not paste the entire JSON unless the user explicitly asks for it.
- When a precondition is not met (binary missing, or too old to support the catalog), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Working directory where the binary is run. The catalog does not depend on cwd (it is a static constant); defaults to the process cwd when omitted.'
          ),
        section: z
          .enum(['fields', 'navigation', 'app-config', 'dashboard', 'all'])
          .optional()
          .describe(
            'Which slice of the catalog to return. The binary defaults to "all" when omitted (forward-only: not sent unless supplied).'
          ),
      },
      annotations: {
        title: 'Get UDF Catalog',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, section }) => {
      const resolvedCwd = cwd ? resolve(cwd) : process.cwd();

      // Precondition check: the restforge-designer binary must be reachable on PATH.
      // Treated as a non-error precondition per the authoring guide §3.4.
      const probe = await execProcess('npx', ['restforge-designer', '--version'], {
        cwd: resolvedCwd,
        timeout: 10_000,
      });
      if (!probe.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the RESTForge Designer command-line tool could not be run via npx (the @restforgejs/platform package may not be installed in this folder).

Working directory: ${resolvedCwd}
Probe command: ${probe.command}
Exit code: ${probe.exitCode}

For the assistant:
- Make sure this project was created with 'npx create-restforge-app' (or the @restforgejs/platform package is installed in the project folder) before the UDF catalog can be retrieved, then try again.
- When explaining to the user, say something like "the RESTForge Designer tool couldn't run — make sure this project was created with create-restforge-app (or the RESTForge platform package is installed here), then try again". Do not mention internal tool names.
- Once it can run, retry getting the catalog.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied (forward-only per §3.5 / D6).
      const args = ['catalog'];
      if (section) args.push(`--section=${section}`);

      const result = await execProcess('npx', ['restforge-designer', ...args], {
        cwd: resolvedCwd,
        timeout: 15_000,
      });

      // Branch 1 — binary too old: the 'catalog' subcommand does not exist yet.
      // Best-effort detection: a failed run whose output carries clap's
      // "unrecognized subcommand" error. Mapped to a NON-error precondition
      // (binary needs updating), per the campaign note and §3.4.
      const combinedOutput = `${result.stderr}\n${result.stdout}`.toLowerCase();
      if (!result.success && combinedOutput.includes('unrecognized subcommand')) {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the installed RESTForge Designer does not support the UDF catalog yet.

Working directory: ${resolvedCwd}
Installed version: ${probe.stdout.trim() || 'unknown'}
Command: ${result.command}
Exit code: ${result.exitCode}

For the assistant:
- The installed RESTForge Designer is too old: it does not recognize the catalog command.
- When explaining to the user, say something like "your RESTForge Designer is an older version that doesn't expose the UDF catalog yet — please update RESTForge Designer to the latest version and try again". Do not mention internal tool names.
- Once it is updated, retry getting the catalog.`,
            },
          ],
          isError: false, // non-error precondition: binary needs updating
        };
      }

      // Branch — unexpected crash/timeout: no real exit code (-1). Pre-flight
      // already confirmed the binary spawns, so this is a real failure per §3.4.
      if (result.exitCode === -1) {
        return {
          content: [
            {
              type: 'text',
              text: `Getting the UDF catalog did not complete — the command crashed or timed out.

Working directory: ${resolvedCwd}
Command: ${result.command}

--- stderr ---
${result.stderr}
--- end stderr ---

For the assistant:
- The Designer CLI did not finish (likely a crash or timeout), so there is no catalog to report.
- Tell the user the catalog could not be retrieved and offer to retry. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4 — unexpected crash/timeout
        };
      }

      // Branch 3 — other non-zero exit: the binary recognizes 'catalog' but failed
      // for another reason. Read-only relay per D7 (isError:false), guide the model
      // to read the output.
      if (!result.success) {
        const stderrBlock = result.stderr
          ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
          : '';
        return {
          content: [
            {
              type: 'text',
              text: `Getting the UDF catalog ran but reported a non-zero exit.

Working directory: ${resolvedCwd}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- The Designer CLI ran to completion but returned a non-zero exit. Read the output above and relay the situation to the user; this is a verdict to convey, not a tool malfunction.
- Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names. Match the user's language.`,
            },
          ],
          isError: false, // read-only relay per D7
        };
      }

      // Branch 2 — success: pass the catalog JSON through untouched, with grounding
      // guidance for the assistant. We do not reshape or interpret the catalog.
      let parsed: unknown = null;
      let prettyJson = result.stdout;
      let catalogVersion: string | number = 'unknown';
      let sectionsLabel: string = section ?? 'all';
      try {
        parsed = JSON.parse(result.stdout);
        prettyJson = JSON.stringify(parsed, null, 2);
        const root = (parsed ?? {}) as Record<string, unknown>;
        if (typeof root.udfCatalogVersion === 'number' || typeof root.udfCatalogVersion === 'string') {
          catalogVersion = root.udfCatalogVersion;
        }
        // When no --section was supplied, the binary returns the full catalog; surface
        // which top-level sections are present (excluding the version marker).
        if (!section) {
          const keys = Object.keys(root).filter((k) => k !== 'udfCatalogVersion');
          if (keys.length > 0) sectionsLabel = keys.join(', ');
        }
      } catch {
        // Success exit but unparseable output: relay raw stdout rather than hard-fail
        // (read-only designer tool, D7). The fenced block below carries the raw text.
      }

      return {
        content: [
          {
            type: 'text',
            text: `UDF catalog retrieved successfully.

Working directory: ${resolvedCwd}
Source: npx restforge-designer (serialized from validator constants) — single source of truth for the installed designer version
Installed version: ${probe.stdout.trim() || 'unknown'}
udfCatalogVersion: ${catalogVersion}
Section(s): ${sectionsLabel}

--- UDF Catalog (JSON) ---
${prettyJson}
--- end UDF Catalog (JSON) ---

For the assistant:
- Confirm to the user that the catalog is available. Summarise in plain language (e.g. how many valid field types, which sections are present).
- Do not paste the full JSON block unless the user explicitly asks. If the user only asked to "see the catalog", offer to drill into a specific section (fields, navigation, app-config, dashboard) instead of dumping everything.
- When authoring or editing a UDF payload, use this catalog as ground truth to:
  * Restrict field "type" to the values in fields.validFieldTypes; reject anything else as invalid.
  * Ensure appConfig includes every entry in appConfig.requiredFields, and keep port within appConfig.port range.
  * Restrict editor modes, badge colors, id-generation modes/formats, navigation item types, and navigation depth to the enums and limits in the catalog.
  * Restrict dashboard widget types, chart engines, and data source methods to the dashboard section's enums, and respect widgetsRequiringFields / forbiddenFields.
- This is the DESIGNER (frontend UDF) catalog. Do not confuse it with the backend field validation catalog used for RDF payload fieldValidation constraints.
- Do not mention internal tool names. Match the user's language.`,
          },
        ],
      };
    }
  );
}
