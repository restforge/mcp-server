import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenMigratePayload(server: McpServer): void {
  server.registerTool(
    'codegen_migrate_payload',
    {
      title: 'Migrate Payload (RDF backend -> UDF frontend)',
      description: `Convert an existing backend payload file (RDF) into a frontend payload (UDF) for RESTForge Designer, by wrapping restforge payload migrate. The output is always a SPLIT multi-file set written into an output directory (app-config.json, one file per page under pages/, and an aggregator <appCode>.json), not a single UDF file. The migrator also auto-discovers JOINed tables, so one JOINed RDF can produce several pages at once.

PRIMARY PATH TO CREATE A UDF (firm): this is the FIRST and preferred way to produce a UDF. RESTForge is backend-first — a UDF is normally DERIVED from an existing backend RDF via this tool, not written by hand. Whenever a backend RDF payload exists and the user wants a UDF/frontend, START HERE. Only hand-author a UDF from scratch (grounded by 'designer_get_udf_catalog') when there is genuinely no RDF to migrate from.

USE WHEN:
- The user wants to CREATE or start a frontend UDF and a backend RDF payload exists — this is the default on-ramp, before any hand-authoring
- The user wants to build a frontend UDF from an existing backend payload, e.g. "buat UDF dari payload backend", "konversi RDF ke UDF", "migrate payload ke frontend", "bikin payload designer dari backend existing"
- The user has a working backend payload and now wants to start authoring the matching frontend in RESTForge Designer (on-ramp from backend to frontend)
- The user mentions migrating, converting, or porting a backend payload over to the designer / frontend side

DO NOT USE FOR:
- Generating the actual frontend web application from a UDF that already exists -> use the designer generate action (describe it by what it does, do not name the tool)
- Validating a backend payload against the database schema -> use 'codegen_validate_payload'
- Generating a backend payload from a database table that has no payload yet -> use 'codegen_generate_payload'

This tool runs: npx restforge payload migrate --name=<name> --project=<project> [--output] [--config] [--app-name] [--app-code] [--plugin] [--port] [--overwrite] in the given cwd.
The CLI reads the backend RDF (resolved relative to cwd or cwd/payload/), reads SERVER_ADDRESS/SERVER_PORT from the DB config (or the default config) to build apiBaseUrl, and writes the split UDF files into the output directory (default frontend/payload/).

Cross-reference (downstream UDF flow):
- This tool is the on-ramp that creates a UDF from an existing backend RDF. Its split UDF output is consumed by the designer tools: validate it with 'designer_validate_payload', dry-run it with 'designer_preview_files', and generate the frontend with 'designer_generate' — always point those at the aggregator file (<appCode>.json), not the individual page fragments.
- To see the target UDF structure and rules (valid field types, required appConfig fields, enums, limits), use 'designer_get_udf_catalog'.
- Canonical UDF flow: codegen_migrate_payload -> designer_get_udf_catalog -> designer_validate_payload -> designer_preview_files -> designer_generate.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The named RDF payload file must exist (resolved relative to cwd or cwd/payload/).
- Without --overwrite, the command fails if any split output file already exists in the output directory.
  This tool does not pre-check those — if the CLI fails, the failure response will surface the cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "convert the backend payload into a frontend payload", "validate the frontend payload", "generate the frontend application").
- Speak in plain language. Confirm the migration, mention the output directory and that the result is a split multi-file UDF; do not paste the raw CLI output unless the user explicitly asks.
- After a successful migration, the usual next steps are to validate the resulting UDF, preview it, or generate the frontend application from it. Describe those steps by what they do; do not name internal tools.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the backend project folder (must contain node_modules/@restforgejs/platform; the RDF payload is read from here)'),
        name: z
          .string()
          .min(1)
          .describe('Backend RDF payload file name (e.g. visitors.json). Resolved relative to cwd or cwd/payload/. REQUIRED.'),
        project: z
          .string()
          .min(1)
          .describe('Project name in kebab-case, used as the path segment in apiBaseUrl (http://{host}:{port}/api/{project}). REQUIRED.'),
        output: z
          .string()
          .min(1)
          .optional()
          .describe('Output directory for the split UDF files, relative to cwd. When omitted, the CLI uses its default (frontend/payload/). A value ending in .json is reduced to its parent directory.'),
        config: z
          .string()
          .min(1)
          .optional()
          .describe('Database config file (.env) read for SERVER_ADDRESS/SERVER_PORT (backend host/port). When omitted, the CLI falls back to the default config.'),
        appName: z
          .string()
          .min(1)
          .optional()
          .describe('Value for appConfig.appName in the UDF output. When omitted, derived from project in Title Case (e.g. visitors-app -> "Visitors App").'),
        appCode: z
          .string()
          .min(1)
          .optional()
          .describe('Value for appConfig.appCode in the UDF output (kebab-case). Also used as the aggregator file name (<appCode>.json). When omitted, follows project.'),
        plugin: z
          .string()
          .min(1)
          .optional()
          .describe('Designer plugin ID written to appConfig.plugin. When omitted, the CLI uses its default (vanilla-js-basic).'),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('Frontend application port written to appConfig.port. Independent of the backend port used in apiBaseUrl. When omitted, the CLI uses its default (8000).'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Overwrite existing split output files. Without it, the command fails if any split file already exists in the output directory.'),
      },
      annotations: {
        title: 'Migrate Payload (RDF backend -> UDF frontend)',
        readOnlyHint: false,
        idempotentHint: false, // re-running can fail or overwrite depending on --overwrite
        destructiveHint: false,
      },
    },
    async ({ cwd, name, project, output, config, appName, appCode, plugin, port, overwrite }) => {
      const projectCwd = resolve(cwd);

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
Requested RDF: ${name}
Requested project: ${project}

For the assistant:
- The user needs to install the RESTForge package before a backend payload can be migrated into a frontend payload.
- Suggest installing the package first, then retry the migration.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied. CLI defaults
      // (frontend/payload/ output, vanilla-js-basic plugin, port 8000, etc.)
      // stay in effect when the user does not specify them. per §3.5
      const args = ['restforge', 'payload', 'migrate', `--name=${name}`, `--project=${project}`];
      if (output) args.push(`--output=${output}`);
      if (config) args.push(`--config=${config}`);
      if (appName) args.push(`--app-name=${appName}`);
      if (appCode) args.push(`--app-code=${appCode}`);
      if (plugin) args.push(`--plugin=${plugin}`);
      if (port !== undefined) args.push(`--port=${port}`);
      if (overwrite) args.push('--overwrite');

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 60_000 });

      // Branch C: CLI failure — real error per §3.4. A failed or partial migration
      // needs recovery, so this is isError: true. Structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to migrate the backend payload into a frontend payload.

Project path: ${projectCwd}
RDF name: ${name}
Project: ${project}
Output: ${output ?? 'default (frontend/payload/)'}
Config: ${config ?? 'default config'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that the payload migration did not complete successfully, and that any partially written output may need cleanup.
- Summarise the most likely cause from the CLI output in plain language. Common causes:
  * The named RDF payload was not found — it is resolved relative to cwd or cwd/payload/. Suggest checking the file name and location.
  * The database config could not be read (missing or incomplete SERVER_ADDRESS/SERVER_PORT), or no default config is set. Suggest pointing at a valid config file.
  * Output files already exist and --overwrite was not set — suggest re-running with overwrite enabled or choosing a different output directory.
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
            text: `Payload migration completed (RDF backend -> UDF frontend).

Project path: ${projectCwd}
RDF name: ${name}
Project: ${project}
Output dir: ${output ?? 'default (frontend/payload/)'}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm to the user that the backend payload was converted into a frontend payload. Mention that the output is a split multi-file set (a shared app-config file, one file per page under pages/, and an aggregator file) written into the output directory above.
- Read the CLI output for the number of pages and the file list; mention how many pages were produced (auto-discovered JOINs can produce more than one page from a single RDF).
- Suggest the usual next steps in plain language: validate the resulting frontend payload, preview it, or generate the frontend application from it (always pointing at the aggregator file, not the individual page fragments). Do not name internal tools.
- Keep the reply concise. Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
