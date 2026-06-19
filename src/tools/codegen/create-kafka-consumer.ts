import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerCodegenCreateKafkaConsumer(server: McpServer): void {
  server.registerTool(
    'codegen_create_kafka_consumer',
    {
      title: 'Create Kafka Consumer',
      description: `Generate Kafka consumer source code from a payload JSON file, by wrapping restforge kafka consumer-create. The output is written under src/consumers/<project>/<name>/ and is later run by the internal 'restforge-consumer' binary.

USE WHEN:
- The user wants to create or scaffold a Kafka consumer from a consumer payload, e.g. "buat kafka consumer", "generate consumer", "create kafka consumer dari payload"
- The user has a consumer payload JSON and wants the matching consumer code generated into a backend project
- The user mentions consuming Kafka topics/events and needs the handler scaffolded

DO NOT USE FOR:
- Generating a REST endpoint -> use 'codegen_create_endpoint'
- Generating a processor / background job -> use 'codegen_create_processor'
- Deploying or running the consumer -> out of scope (the generated code is run by the internal 'restforge-consumer' binary, not this server)

This tool runs: npx restforge kafka consumer-create --project=<project> --name=<name> --payload=<payload> [--force] in the given cwd.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The named consumer payload JSON must exist. This tool does not pre-check it — if the CLI fails, the failure response surfaces the cause.
- Without 'force', the command fails if the consumer files already exist.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "generate the Kafka consumer").
- Speak in plain language; summarise the result. Do not paste raw CLI output unless the user explicitly asks.
- Mention that the generated consumer is run separately by the internal consumer runtime, not by this assistant.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the backend project folder (must contain node_modules/@restforgejs/platform)'),
        project: z.string().min(1).describe('Target project name. REQUIRED.'),
        name: z.string().min(1).describe('Consumer name to create. REQUIRED.'),
        payload: z
          .string()
          .min(1)
          .describe('Path or file name of the consumer payload JSON. REQUIRED.'),
        force: z
          .boolean()
          .optional()
          .describe('Overwrite existing consumer files. Without it, the command fails if the files already exist.'),
      },
      annotations: {
        title: 'Create Kafka Consumer',
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
      },
    },
    async ({ cwd, project, name, payload, force }) => {
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
Requested consumer: ${name}
Requested payload: ${payload}

For the assistant:
- The user needs to install the RESTForge package before a Kafka consumer can be generated.
- Suggest installing the package first, then retry. When explaining, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const args = ['restforge', 'kafka', 'consumer-create', `--project=${project}`, `--name=${name}`, `--payload=${payload}`];
      if (force) args.push('--force');

      const result = await execProcess('npx', args, { cwd: projectCwd, timeout: 60_000 });

      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to create the Kafka consumer.

Project path: ${projectCwd}
Project: ${project}
Consumer: ${name}
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
- Tell the user the Kafka consumer was not generated successfully.
- Summarise the most likely cause from the CLI output in plain language (common causes: the payload file was not found, the payload is invalid, the consumer files already exist without force, or the target project does not exist). Do not paste raw output unless the user asks.
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
            text: `Kafka consumer created.

Project path: ${projectCwd}
Project: ${project}
Consumer: ${name}
Payload: ${payload}
Command: ${result.command}

--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
- Confirm the Kafka consumer source was generated under src/consumers/<project>/<name>/.
- Mention that the consumer is run separately by the internal consumer runtime (restforge-consumer), not by this assistant.
- Keep the reply concise. Do not paste raw CLI output unless the user explicitly asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
