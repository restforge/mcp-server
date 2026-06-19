import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenCreateProcessor(server: McpServer): void {
  server.registerTool(
    'codegen_create_processor',
    {
      title: 'Create Processor Module',
      description: `Generate a processor (a background job / custom business-logic handler) from a payload JSON file, by wrapping restforge processor create. The processor exposes an endpoint whose router + metadata is always regenerated, while the implementation file holds the custom business logic.

USE WHEN:
- The user wants to create or scaffold a processor, background job, or custom business-logic handler from a processor payload, e.g. "buat processor", "generate processor", "create background job", "scaffold business logic handler"
- The user has a processor payload JSON and wants the matching code generated into a backend project
- The user wants to re-generate a processor's routing while keeping their hand-written logic (re-run WITHOUT force preserves custom code)

DO NOT USE FOR:
- Generating a standard REST endpoint from a payload -> use 'codegen_create_endpoint'
- Generating a dashboard endpoint -> use 'codegen_create_dashboard'
- Generating a Kafka consumer -> use 'codegen_create_kafka_consumer'
- Generating a backend payload from a database table -> use 'codegen_generate_payload'

This tool runs: npx restforge processor create --project=<project> --name=<name> --payload=<payload> [--database] [--force] [--skip-sql-validation] in the given cwd.

Re-run behavior (important):
- WITHOUT 'force': the endpoint router + metadata are regenerated, but the processor implementation file is SKIPPED ("custom code preserved") — safe to re-run to refresh routing without losing hand-written logic.
- WITH 'force': the implementation file is archived first, then overwritten with a fresh scaffold — custom code survives only in the archive.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The named processor payload JSON must exist. This tool does not pre-check it — if the CLI fails, the failure response surfaces the cause.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "generate the processor", "regenerate the routing").
- Speak in plain language; summarise the result. Do not paste raw CLI output unless the user explicitly asks.
- If the user wants to overwrite existing custom implementation, warn that without archiving they would lose hand-written logic; 'force' archives the old file before overwriting.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the backend project folder (must contain node_modules/@restforgejs/platform)'),
        project: z.string().min(1).describe('Target project name. REQUIRED.'),
        name: z.string().min(1).describe('Processor name (also the endpoint name). REQUIRED.'),
        payload: z
          .string()
          .min(1)
          .describe('Path or file name of the processor payload JSON. REQUIRED.'),
        database: z
          .enum(['postgres', 'mysql', 'oracle', 'sqlite'])
          .optional()
          .describe('Database type. When omitted, the CLI uses its default (postgres / auto-detect).'),
        force: z
          .boolean()
          .optional()
          .describe('Archive then overwrite an existing processor implementation file. Without it, the implementation file is preserved (only routing/metadata regenerate).'),
        skipSqlValidation: z
          .boolean()
          .optional()
          .describe('Skip SQL keyword validation. When omitted, the CLI validates SQL as usual.'),
      },
      annotations: {
        title: 'Create Processor Module',
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
      },
    },
    async ({ cwd, project, name, payload, database, force, skipSqlValidation }) => {
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
Requested processor: ${name}
Requested payload: ${payload}

For the assistant:
- The user needs to install the RESTForge package before a processor can be generated.
- Suggest installing the package first, then retry. When explaining, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const args = ['restforge', 'processor', 'create', `--project=${project}`, `--name=${name}`, `--payload=${payload}`];
      if (database) args.push(`--database=${database}`);
      if (force) args.push('--force');
      if (skipSqlValidation) args.push('--skip-sql-validation');

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 60_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to create the processor.

Project path: ${projectCwd}
Project: ${project}
Processor: ${name}
Payload: ${payload}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user the processor was not generated successfully.
- Summarise the most likely cause from the CLI output in plain language (common causes: the payload file was not found, the payload is invalid, SQL validation failed, or the target project does not exist). Do not paste raw output unless the user asks.
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
            text: `Processor created.

Project path: ${projectCwd}
Project: ${project}
Processor: ${name}
Payload: ${payload}
Force: ${force ? 'yes (old implementation archived then overwritten)' : 'no (existing implementation preserved)'}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm the processor was generated. Mention the endpoint routing/metadata was (re)generated.
- If this was a re-run without force, note that any existing custom implementation was preserved. If force was used, note the old implementation was archived before being overwritten.
- Keep the reply concise. Do not paste raw CLI output unless the user explicitly asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
