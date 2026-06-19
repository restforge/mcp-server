import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerSetupGetInitTemplate(server: McpServer): void {
  server.registerTool(
    'setup_get_init_template',
    {
      title: 'Get Init Template',
      description: `Get raw template content of db-connection.env without writing any file.
Useful as reference after current file has been modified, or for comparing
current config against template defaults (drift detection).

USE WHEN:
- The agent needs to see template defaults after the current file has been modified
- Comparing current config with template (drift detection)
- Restoring template content reference without re-running init
- The user asks things like "show me the default template", "lihat template config default",
  "apa isi template defaultnya", "what does the default config look like",
  "bandingkan dengan template asli", "compare against the original template"

DO NOT USE FOR:
- Generating new config files in the project -> use 'setup_init_config'
- Reading current config -> use 'setup_read_env'
- Getting structured schema (JSON) -> use 'setup_get_config_schema'

This tool runs: npx restforge config:template in the given cwd.
This tool is READ-ONLY and safe to call repeatedly. No file is written.
Requires @restforgejs/platform >= 2.3.1.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "install the package", "set up the initial config", "show the active configuration").
- Speak in plain language. Summarise what the template contains (sections present, total parameters); do not paste the entire template body unless the user explicitly asks for it.
- When a precondition is not met (e.g. the package is not installed), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder (must have @restforgejs/platform installed in node_modules)'),
      },
      annotations: {
        title: 'Get Init Template',
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
- The default config template can only be retrieved once the RESTForge package is installed locally.
- Suggest installing the package first, then retry getting the template.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Run subprocess with NODE_ENV=production to suppress legacy banner output.
      // stripFinalNewline=false to preserve byte-perfect template content
      // (matches the trailing newline in db-connection.env file written by `restforge init`).
      const result = await execProcess(
        'npx',
        ['restforge', 'config', 'template'],
        {
          cwd: projectCwd,
          timeout: 15_000,
          env: { NODE_ENV: 'production' },
          stripFinalNewline: false,
        }
      );

      // CLI failure: real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to retrieve the configuration template.

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
- Tell the user that the default template could not be retrieved.
- A common cause is an older RESTForge version that does not yet expose the template command (requires @restforgejs/platform >= 2.3.1). Suggest upgrading the package as a likely fix.
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Success: one-line summary + labeled facts + fenced template body per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Configuration template retrieved successfully.

Project path: ${projectCwd}
Source: restforge (matches the template that 'init' would write into config/db-connection.env)
Note: this is a read-only preview; no file was written.

--- Template (db-connection.env) ---
${result.stdout}--- end Template (db-connection.env) ---

For the assistant:
- Confirm to the user that the default template is available.
- Summarise the template in plain language: which sections are present (database, license, optional Live Sync / Redis / Kafka / Logging) and the total parameter count.
- Do not paste the full template body unless the user explicitly asks for it. If the user is doing drift detection, the full template content is available between the fenced markers above for programmatic comparison.
- Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
