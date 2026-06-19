import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenGenerateTest(server: McpServer): void {
  server.registerTool(
    'codegen_generate_test',
    {
      title: 'Generate Integration Test',
      description: `Generate a Jest + Supertest integration test file for an EXISTING endpoint, by wrapping restforge test generate.

USE WHEN:
- The user wants to generate, scaffold, or create an integration test for an existing endpoint, e.g. "generate test untuk endpoint", "buat integration test", "scaffold jest test", "create supertest test"
- The user just generated an endpoint and now wants its test
- The user wants to initialise the Jest test-data configuration for a project (with 'init')

DO NOT USE FOR:
- Generating the endpoint itself -> use 'codegen_create_endpoint'
- Running the tests -> out of scope (the user runs the generated tests with their own test runner)
- Validating a payload or SQL -> use 'codegen_validate_payload' / 'codegen_validate_sql'

This tool runs: npx restforge test generate --project=<project> --endpoint=<endpoint> [--port] [--init] [--force] in the given cwd.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The named endpoint must already exist in the project. This tool does not pre-check it — if the CLI fails, the failure response surfaces the cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "generate the integration test").
- Speak in plain language; summarise the result. Do not paste raw CLI output unless the user explicitly asks.
- On the first test for a project, suggest using 'init' to set up the Jest test-data configuration.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the backend project folder (must contain node_modules/@restforgejs/platform)'),
        project: z.string().min(1).describe('Target project name. REQUIRED.'),
        endpoint: z.string().min(1).describe('Name of the existing endpoint to test. REQUIRED.'),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('Server port used when the test runs. When omitted, the CLI uses its default (3000).'),
        init: z
          .boolean()
          .optional()
          .describe('Initialise the Jest test-data configuration (global + per-endpoint) if not present. Use on the first test for a project.'),
        force: z
          .boolean()
          .optional()
          .describe('Overwrite an existing test file. Without it, the command will not replace an existing test.'),
      },
      annotations: {
        title: 'Generate Integration Test',
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
      },
    },
    async ({ cwd, project, endpoint, port, init, force }) => {
      const projectCwd = resolve(cwd);

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
Requested endpoint: ${endpoint}

For the assistant:
- The user needs to install the RESTForge package before an integration test can be generated.
- Suggest installing the package first, then retry. When explaining, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const args = ['restforge', 'test', 'generate', `--project=${project}`, `--endpoint=${endpoint}`];
      if (port !== undefined) args.push(`--port=${port}`);
      if (init) args.push('--init');
      if (force) args.push('--force');

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 60_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to generate the integration test.

Project path: ${projectCwd}
Project: ${project}
Endpoint: ${endpoint}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user the integration test was not generated successfully.
- Summarise the most likely cause from the CLI output in plain language (common causes: the endpoint does not exist yet, the project does not exist, or an existing test blocks generation without force). Do not paste raw output unless the user asks.
- Offer to retry once the issue is resolved. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Integration test generated.

Project path: ${projectCwd}
Project: ${project}
Endpoint: ${endpoint}
Port: ${port ?? 'default (3000)'}
Init: ${init ? 'yes' : 'no'}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm the Jest + Supertest integration test was generated for the endpoint.
- Mention the user runs the test with their own test runner; this server does not run it.
- Keep the reply concise. Do not paste raw CLI output unless the user explicitly asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
