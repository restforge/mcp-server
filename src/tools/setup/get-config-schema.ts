import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerSetupGetConfigSchema(server: McpServer): void {
  server.registerTool(
    'setup_get_config_schema',
    {
      title: 'Get Config Schema',
      description: `Get JSON schema of all parameters available in db-connection.env template.
Schema includes parameter name, section, type (string/integer/boolean), default value,
description, and required status.

USE WHEN:
- The agent needs to know what parameters are configurable before writing config
- Listing available config options for user reference
- Building a dynamic UI or validator from the schema
- The user asks things like "what parameters are available", "list all config options",
  "parameter apa saja yang bisa di-set", "tampilkan schema config", "what can I configure",
  "show me the configurable fields", "field apa saja yang valid"

DO NOT USE FOR:
- Reading actual current config values -> use 'setup_read_env'
- Writing config -> use 'setup_write_env' or 'setup_update_env'
- Getting raw template text -> use 'setup_get_init_template'

This tool runs: npx restforge config:schema in the given cwd.
The schema is sourced from restforge (single source of truth) so it stays
in sync with the restforge runtime version installed in the project.
Requires @restforgejs/platform >= 2.3.1.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "install the package", "fill in the credentials").
- Speak in plain language. Summarise the schema (number of parameters, sections present, key required fields); do not paste the entire JSON unless the user explicitly asks for it.
- When a precondition is not met (e.g. the package is not installed), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder (must have @restforgejs/platform installed in node_modules)'),
      },
      annotations: {
        title: 'Get Config Schema',
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
- The schema can only be retrieved once the RESTForge package is installed locally.
- Suggest installing the package first, then retry getting the schema.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Run subprocess with NODE_ENV=production to suppress legacy banner output
      const result = await execProcess(
        'npx',
        ['restforge', 'config', 'schema'],
        {
          cwd: projectCwd,
          timeout: 15_000,
          env: { NODE_ENV: 'production' },
        }
      );

      // CLI failure: real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to retrieve the configuration schema.

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
- Tell the user that the schema could not be retrieved.
- A common cause is an older RESTForge version that does not yet expose the schema command (requires @restforgejs/platform >= 2.3.1). Suggest upgrading the package as a likely fix.
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
              text: `Failed to parse the schema JSON returned by the CLI.

Project path: ${projectCwd}
Reason: ${msg}

--- Raw stdout ---
${result.stdout}
--- end Raw stdout ---

For the assistant:
- The CLI returned output that is not valid JSON.
- Summarise this to the user in plain language; do not paste the raw stdout unless they explicitly ask.
- Suggest checking that the installed package version is compatible (requires @restforgejs/platform >= 2.3.1). Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Re-stringify for consistent pretty formatting
      const prettyJson = JSON.stringify(parsed, null, 2);

      // Success: one-line summary + labeled facts + fenced JSON output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Configuration schema retrieved successfully.

Project path: ${projectCwd}
Source: restforge (single source of truth for the installed runtime version)

--- Schema (JSON) ---
${prettyJson}
--- end Schema (JSON) ---

For the assistant:
- Confirm to the user that the schema is available.
- Summarise in plain language: how many parameters there are, which sections are present (e.g. database, license, optional Live Sync / Redis / Kafka / Logging), and which fields are required.
- Do not paste the full JSON block unless the user explicitly asks for it. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
