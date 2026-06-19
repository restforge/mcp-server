import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenGeneratePayload(server: McpServer): void {
  server.registerTool(
    'codegen_generate_payload',
    {
      title: 'Generate Payload',
      description: `Generate a payload spec file (metadata, fields, action specs) from a database table by introspecting its schema via restforge.

USE WHEN:
- The user asks to generate a payload, payload spec, or payload metadata file from a database table
- The user asks things like "buatkan payload dari table X", "generate payload guest_book", "scan schema table to JSON", "create payload for endpoint generation"
- The user wants to "introspect" or "scan" a database table into a JSON spec
- Starting CLI codegen workflow after the project config has been validated
- Re-generating payload after a schema change in the database

DO NOT USE FOR:
- Filling in credentials in db-connection.env -> use 'setup_write_env'
- Validating config before generating payload -> use 'setup_validate_config'
- Creating the project / endpoint code from a payload -> that is the next CLI step (will be wrapped in a future tool, not yet available)

This tool runs: npx restforge payload generate --table=<table> --config=<config> in the given cwd.
The CLI connects to the database described in the config file, reads the table schema,
and writes a payload JSON file (e.g. table 'guest_book' -> 'guest-book.json' with underscore
mapped to hyphen). The payload file is the input for the next codegen step (project + endpoint creation).

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The config file (default 'db-connection.env') must exist in the project and contain valid
  database credentials. This tool does not pre-check that — if the CLI fails, the failure response
  will surface the underlying cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "install the package", "fill in the credentials", "generate the payload").
- Speak in plain language. Summarise the result; do not paste raw CLI output unless the user explicitly asks.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform and the config file)'),
        table: z
          .string()
          .min(1)
          .describe('Name of the database table to introspect (e.g. guest_book)'),
        config: z
          .string()
          .min(1)
          .default('db-connection.env')
          .describe('Config file name (relative to project) used by the CLI to connect to the database'),
      },
      annotations: {
        title: 'Generate Payload',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async ({ cwd, table, config }) => {
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
Requested table: ${table}
Requested config: ${config}

For the assistant:
- The user needs to install the RESTForge package before a payload can be generated from a table schema.
- Use the appropriate package-installation tool to do this, then retry generating the payload.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      const result = await execProcess(
        'npx',
        ['restforge', 'payload', 'generate', `--table=${table}`, `--config=${config}`],
        { cwd: projectCwd, timeout: 30_000 }
      );

      // CLI failure: real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to generate payload.

Project path: ${projectCwd}
Table: ${table}
Config: ${config}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that generating the payload did not complete successfully.
- Summarise the likely cause from the CLI output in plain language (common causes: the config file is missing or has incomplete credentials, the database is unreachable, or the requested table does not exist in the database). Do not paste the raw stdout/stderr unless the user explicitly asks.
- Offer to retry once the underlying issue is resolved. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Success: one-line summary + labeled facts + fenced raw output per §3.5.
      // The CLI itself prints the output filename in stdout; we do not try to re-derive it here.
      return {
        content: [
          {
            type: 'text',
            text: `Payload generated successfully.

Project path: ${projectCwd}
Table: ${table}
Config: ${config}
Output: payload file generated by restforge (see CLI output below for the exact filename; underscores in the table name are mapped to hyphens, e.g. 'guest_book' -> 'guest-book.json').

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm to the user that the payload spec for the requested table is ready.
- Mention in plain language that the payload is the input for the next codegen step (generating the project and endpoint code from this payload). That follow-up step is part of the CLI workflow but is not wrapped as a tool yet.
- Suggest that the user can review or edit the generated payload file before the next step.
- This output is a single-table skeleton. For a transactional module with a header-detail relationship or a status-driven lifecycle, the advanced blocks (master-detail, workflow, and the composite/workflow action keys) are NOT generated and must be added manually. Ground that manual edit in the RESTForge handbook (catalogs/rdf/master-detail.md, catalogs/rdf/workflow.md, catalogs/rdf/file-reference.md) rather than guessing the structure; for the 'file:' query convention, the query declarative catalog applies. Only raise this when the user's intent points to such a module.
- Keep the reply concise. Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
