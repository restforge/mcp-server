import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerSetupInitConfig(server: McpServer): void {
  server.registerTool(
    'setup_init_config',
    {
      title: 'Init RESTForge Config',
      description: `Generate a skeleton config file in the project folder via restforge.

USE WHEN:
- The project has @restforgejs/platform installed in node_modules
- The config/ folder does not exist yet, or you want to reset it to the default template
- Starting RESTForge project configuration from scratch

DO NOT USE FOR:
- Installing @restforgejs/platform -> use 'setup_install_package'
- Filling in credentials in db-connection.env -> use 'setup_write_env'

This tool runs: npx restforge init in the given cwd.
Output: config/db-connection.env (empty template).

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "install the package", "fill in the credentials").
- Speak in plain language. Summarise the result; do not paste raw CLI output unless the user explicitly asks.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder'),
      },
      annotations: {
        title: 'Init Config',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async ({ cwd }) => {
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

For the assistant:
- The user needs to install the RESTForge package before the initial config can be generated.
- Use the appropriate package-installation tool to do this, then retry generating the config.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const result = await execProcess(
        'npx',
        ['restforge', 'init'],
        { cwd: projectCwd, timeout: 30_000 }
      );

      // CLI failure: real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to generate the initial RESTForge configuration.

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
- Tell the user that the initialisation command did not complete successfully.
- Summarise the likely cause from the CLI output in plain language; do not paste the raw stdout/stderr unless the user explicitly asks for it.
- Offer to retry once the underlying issue is resolved. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      // Success: one-line summary + labeled facts + fenced raw output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Initial RESTForge configuration generated successfully.

Project path: ${projectCwd}
Files created:
- config/db-connection.env (empty template, awaiting credentials)

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm to the user that the project skeleton is ready.
- Suggest the next step in plain words: the credentials file (license and database connection) still needs to be filled in before the project can run.
- Keep the reply concise. Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
