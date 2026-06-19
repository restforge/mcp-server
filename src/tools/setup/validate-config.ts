import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerSetupValidateConfig(server: McpServer): void {
  server.registerTool(
    'setup_validate_config',
    {
      title: 'Validate RESTForge Config',
      description: `Validate the RESTForge license and connections to database, redis, and kafka based on the config file.

USE WHEN:
- The db-connection.env file has been filled in (license + DB credentials)
- After credentials have been written or updated, to verify they actually work
- Before starting runtime or codegen operations
- Verifying license and access to external services before deploy
- Diagnosing configuration issues
- The user asks things like "test connection", "cek license", "validate config",
  "apakah config sudah benar", "is the database reachable", "tes koneksi",
  "verify the configuration", "cek apakah license valid"
- Before validating, consider calling 'setup_read_env' to confirm what is
  currently set — especially when the user describes the validation relative
  to a recent change (e.g. "cek apakah license barunya valid"). // per §5.3
- The user wants to validate CONFIGURATION (license, database connection, kafka, redis), not payload files

DO NOT USE FOR:
- Writing the config file -> use 'setup_write_env'
- Adjusting individual fields -> use 'setup_update_env'
- Generating module code -> use codegen_* domain tools
- Checking if payload JSON files are still in sync with the database schema -> use 'codegen_validate_payload'

Often called as the final step after 'setup_write_env' or 'setup_update_env'
has filled in or changed credentials, to confirm that they actually work. // per §5.2

This tool runs: npx restforge validate --config=<configFile> in the given cwd.
This tool is READ-ONLY and safe to call repeatedly.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "fill in the credentials", "update a single value", "set up the initial config").
- Speak in plain language. Summarise the validation result by component (license, database, optional redis/kafka); do not paste the raw CLI output unless the user explicitly asks.
- The CLI output may contain license fragments, host names, or user names. Do not echo license keys, passwords, or full connection URIs into chat. Confirm validation status only.
- When a precondition is not met (e.g. config file is missing), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder'),
        configFile: z
          .string()
          .default('db-connection.env')
          .describe('Config file name in the config/ folder. Default: db-connection.env'),
      },
      annotations: {
        title: 'Validate Config',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, configFile }) => {
      const projectCwd = resolve(cwd);
      const configPath = join(projectCwd, 'config', configFile);

      // Precondition check: the config file must exist before it can be validated.
      // Treated as a non-error precondition per the authoring guide §3.4.
      try {
        await access(configPath);
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the configuration file does not exist yet.

Project path: ${projectCwd}
Expected file: ${configPath}

For the assistant:
- The user is trying to validate a configuration that has not been created and filled in yet.
- Suggest generating the initial RESTForge configuration first, then filling in the license and database credentials, and finally retrying the validation.
- When explaining to the user, say something like "there's no configuration to validate yet — should I set up the initial config first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      const result = await execProcess(
        'npx',
        ['restforge', 'validate', `--config=${configFile}`],
        { cwd: projectCwd, timeout: 30_000 }
      );

      // Validation failure: real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Configuration validation did not pass.

Project path: ${projectCwd}
Config file: ${configPath}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout || '(empty)'}

stderr:
${result.stderr || '(empty)'}
--- end CLI output ---

For the assistant:
- Tell the user that the validation reported one or more problems.
- Summarise the likely failing component in plain language (license, database, redis, kafka) based on the CLI output; do not paste the raw stdout/stderr unless the user explicitly asks.
- Do not echo license keys, passwords, or full connection URIs from the output into chat.
- Suggest reviewing or updating the relevant credentials and retrying. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Success: one-line summary + labeled facts + fenced raw output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `Configuration validation passed.

Project path: ${projectCwd}
Config file: ${configPath}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
${result.stdout || '(empty)'}
--- end CLI output ---

For the assistant:
- Confirm to the user that the license and external connections checked out.
- Summarise in plain language which components were checked and passed (license, database, optional redis/kafka), based on what appears in the CLI output.
- Do not paste the raw CLI output unless the user explicitly asks. Do not echo license keys or credentials. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
