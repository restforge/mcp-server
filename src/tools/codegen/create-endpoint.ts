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

export function registerCodegenCreateEndpoint(server: McpServer): void {
  server.registerTool(
    'codegen_create_endpoint',
    {
      title: 'Create Endpoint Module',
      description: `Generate a project + endpoint module (submodule, model, metadata, demo files, optional audit migration) from an existing payload spec by wrapping restforge create. URL pattern produced: /api/{project}/{endpoint}/{action}.

This tool is DESTRUCTIVE: it spawns the CLI which writes / overwrites files in 'src/modules/<project>/', 'src/models/<project>/', 'metadata/<project>/', 'examples/<project>/<endpoint>/', and updates '.restforge/projects.json'. Single-call semantics: the tool always executes; there is no preview mode. Internally the tool always passes '--force=true' to the CLI to bypass the CLI's interactive y/N readline prompt (which would deadlock in a no-TTY subprocess).

Safety net: when the CLI overwrites an existing module, model, or query directory, it FIRST renames the previous version to '<name>.archive.NNN' (NNN is a sequential generation number starting at 001) inside the same folder. Rollback by restoring the most recent archive is always possible.

AI responsibility — IMPORTANT: because this tool always executes and may overwrite generated files, you MUST confirm intent with the user in plain language BEFORE invoking the tool. You do NOT need to detect file conflicts programmatically — the CLI handles that and the archive mechanism keeps the previous version safe. Just confirm intent. Examples of good confirmation phrasing in user-facing chat:
- "Saya akan generate endpoint <endpoint> di project <project> ({database}). Kalau modul/model lama sudah ada, versi sebelumnya akan disimpan sebagai '.archive.NNN'. Lanjut?"
- "I will generate <endpoint> under project <project> using <database>. Existing files will be archived as .archive.NNN before being overwritten. Proceed?"

USE WHEN:
- The user asks to generate, create, or scaffold an endpoint, resource, or module from a payload (e.g. "buatkan endpoint untuk product", "generate resource users", "create endpoint dari payload X", "scaffold a new endpoint")
- The user mentions "endpoint", "resource", "module" or the URL pattern /api/{project}/{resource}/{action} and wants to register it as runnable code
- The user has authored a payload file (e.g. via 'codegen_generate_payload' or manually) and now wants to materialise it as runnable code in the project
- Pertanyaan dalam bentuk: "tambahkan endpoint X ke project Y", "buat module baru di project Z", "scaffold endpoint baru pakai payload ini", "generate kode dari payload ini"
- The user asks to add a new endpoint to an existing project (registry already has the project, just adding more endpoints)
- The user asks to bootstrap a brand-new project together with its first endpoint
- The user asks about regenerating an existing endpoint after the payload changed (this triggers overwrite + archive flow inside the CLI; previous versions become '.archive.NNN' in place)
- After 'codegen_validate_payload' confirmed the payload is valid — this is the natural follow-up that turns a verified payload into runnable code

DO NOT USE FOR:
- Generating the payload JSON itself from a database table -> use 'codegen_generate_payload'
- Validating a payload before generation -> use 'codegen_validate_payload'
- Inspecting per-column differences between payload and database -> use 'codegen_diff_payload'
- Syncing payload changes back into existing payload files after schema drift -> use 'codegen_sync_payload'
- Looking up the field validation catalog before authoring the payload -> use 'codegen_get_field_validation_catalog'
- Looking up the query declarative catalog before authoring the payload -> use 'codegen_get_query_declarative_catalog'
- Deleting a project or endpoint — out of scope; the user must run 'npx restforge drop' manually
- Generating a processor (Kafka consumer, etc.) — out of scope; the CLI has separate 'processor' and 'consumer-create' subcommands not covered by this MCP server yet
- Generating a dashboard endpoint — out of scope; the CLI has a separate 'dashboard' subcommand
- Listing all registered projects in the registry — out of scope here; use the CLI's 'list' subcommand directly
- Database DDL changes (CREATE TABLE, ALTER TABLE) — not in this tool's scope. The audit migration sub-step DOES create a single audit table when the payload uses the 'audit' fieldPolicy strategy, but that is the only DDL it touches.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The payload file must exist at <cwd>/payload/<payload>.json before calling this tool.
- The CLI itself rejects reserved project names (src, lib, node_modules, config, utils, models, controllers, middleware, routes) and reserved endpoint names (health, status, admin, api, auth, login, logout, register, index, main, app, config, test, docs, swagger, graphql, websocket, socket). When in doubt, ask the user to pick a different name before invoking this tool.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "the endpoint generator", "the project generator", "generate the payload first", "validate the payload first").
- Speak in plain language. Summarise the result; do not paste raw CLI output unless the user explicitly asks.
- This tool is destructive: it can overwrite existing module / model / query files. BEFORE invoking this tool, ALWAYS confirm with the user in plain language. Example: "Saya akan generate endpoint <endpoint> di project <project>. Kalau file lama sudah ada, akan ditimpa (versi lama disimpan sebagai .archive.NNN). Lanjut?". Do not detect conflicts programmatically; the CLI handles that and creates the archive.
- After the tool runs, summarise the result. Read the CLI output and identify any archive activity (the CLI uses the '.archive.NNN' naming convention in the filesystem and reports archive activity in its output, but the exact wording may evolve). When archives are created, tell the user that previous versions are preserved in case rollback is needed.
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
        endpoint: z
          .string()
          .min(1)
          .max(50)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'must start with a letter or number; only letters, numbers, dashes, underscores allowed')
          .describe('Endpoint name (also called "resource" — the URL pattern is /api/{project}/{endpoint}/{action}). Same shape as project. Auto-lowercased by the CLI. Reserved names rejected by the CLI: health, status, admin, api, auth, login, logout, register, index, main, app, config, test, docs, swagger, graphql, websocket, socket. Naming convention: kebab-case or snake-case recommended.'),
        payload: z
          .string()
          .min(1)
          .max(50)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'must start with a letter or number; only letters, numbers, dashes, underscores allowed')
          .describe('Payload file name without the .json extension. The file must exist at <cwd>/payload/<payload>.json. Same shape rules as project.'),
        database: z
          .enum(['postgres', 'oracle', 'mysql'])
          .optional()
          .describe('Database type for the generated code. Default postgres.'),
        createDemo: z
          .boolean()
          .optional()
          .describe('Default true (CLI default). When true, generate demo files (curl, postman, insomnia) for testing the endpoint.'),
        skipSqlValidation: z
          .boolean()
          .optional()
          .describe('Default false (CLI default). When true, skip SQL keyword validation in the payload. Useful when payload includes generated SQL fragments that the validator flags as suspicious.'),
        noAuditMigration: z
          .boolean()
          .optional()
          .describe('Default false (CLI default). When true, skip executing the audit table migration even if the payload has fieldPolicy.*.strategies containing "audit". The migration SQL file is still written to migrations/audit/ as documentation.'),
      },
      annotations: {
        title: 'Create Endpoint Module',
        readOnlyHint: false,    // tool spawns CLI that writes module/model/metadata/demo files and updates the registry
        destructiveHint: true,  // can overwrite existing files (CLI archives them as .archive.NNN first)
        idempotentHint: false,  // re-running creates new archive files and may execute audit migration again
      },
    },
    async ({ cwd, project, endpoint, payload, database, createDemo, skipSqlValidation, noAuditMigration }) => {
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
Requested endpoint: ${endpoint}
Requested payload: ${payload}
Requested database: ${dbType}

For the assistant:
- The endpoint generator can only run once the RESTForge package is installed locally.
- Suggest installing the package first, then retry generating the endpoint.
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
Requested endpoint: ${endpoint}
Requested database: ${dbType}

For the assistant:
- The endpoint generator needs the payload file to exist before it can run.
- Suggest generating or creating the payload first. The payload generator tool can introspect a database table into a payload JSON, or the user can author it manually in the payload/ folder.
- When explaining to the user, say something like "the payload file '${payload}.json' isn't in the payload/ folder yet — should I generate it from a database table first, or do you have one to put there?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Build CLI invocation. --force=true is hardcoded: it bypasses the interactive readline
      // prompt that would otherwise deadlock the subprocess. Conflict detection and archive
      // creation are delegated to the CLI (single source of truth — see conflict-checker.js).
      const cliArgs = [
        'restforge',
        'endpoint',
        'create',
        `--project=${project}`,
        `--name=${endpoint}`,
        `--payload=${payload}`,
        `--database=${dbType}`,
        '--force=true',
      ];
      if (createDemo !== undefined) cliArgs.push(`--create-demo=${createDemo}`);
      if (skipSqlValidation !== undefined) cliArgs.push(`--skip-sql-validation=${skipSqlValidation}`);
      if (noAuditMigration !== undefined) cliArgs.push(`--no-audit-migration=${noAuditMigration}`);

      const result = await execProcess(
        'npx',
        cliArgs,
        {
          cwd: projectCwd,
          timeout: 120_000,
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
              text: `Failed to create the endpoint module.

Project path: ${projectCwd}
Project: ${project}
Endpoint: ${endpoint}
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
- Tell the user that creating the endpoint module did not complete successfully.
- Summarise the most likely cause from the CLI output in plain language. Common causes:
  * Reserved name rejected by the validator (project or endpoint name is in the reserved list) — suggest picking a different name.
  * Database mismatch with the existing project registry entry — the CLI refuses to switch the database for an existing project. Suggest sticking with the originally registered database, or confirm with the user that switching is really intended.
  * Payload validation failed (e.g. SQL keywords flagged) — suggest validating the payload first to surface the specific issue, or rerunning with skipSqlValidation=true if the SQL fragments are intentional.
  * Audit migration failed (e.g. cannot connect to the database) — suggest checking the database connection config, or rerunning with noAuditMigration=true to skip the live migration (the SQL file will still be written for manual execution).
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.
- Offer to retry once the underlying issue is resolved.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Branch D: CLI success — one-line summary + labeled facts + fenced output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Endpoint module created successfully.

Project path: ${projectCwd}
Project: ${project}
Endpoint: ${endpoint}
Payload: payload/${payload}.json
Database: ${dbType}

Generated artefacts (commonly produced by the CLI):
- src/modules/${project}/${endpoint}.js (submodule)
- src/models/${project}/${endpoint}.js (model)
- src/models/${project}/query/ (if payload uses file reference queries)
- metadata/${project}/${endpoint}.json (and related metadata)
- examples/${project}/${endpoint}/* (if createDemo=true)
- migrations/audit/<table>_audit.sql (if payload uses fieldPolicy 'audit' strategy)
- .restforge/projects.json (registry update)

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm to the user in plain language that the project and endpoint were generated. Mention the project, endpoint, and database used.
- Do not paste the entire CLI output unless the user explicitly asks; summarise instead.
- Suggest natural follow-up actions appropriate to context: review the generated files, run the project to test the new endpoint, generate a processor or test, etc. Do not mention internal tool names.
- Read the CLI output to identify any archive activity. The CLI uses the '.archive.NNN' naming convention in the filesystem; it also reports archive activity in its output, though the exact phrasing may evolve. When archives are created, tell the user that the previous version of each overwritten file is preserved as an archive file in the same folder, and explain where to find them if rollback is needed.
- Read the CLI output to identify any audit migration activity (the CLI reports it when the payload uses a fieldPolicy 'audit' strategy). When present, summarise it briefly to the user (e.g. that the audit table for the related table was created or updated).
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
