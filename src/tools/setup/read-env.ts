import { z } from 'zod';
import { readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseEnvFile, isSensitiveKey, maskValue } from '../../lib/env-parser.js';

export function registerSetupReadEnv(server: McpServer): void {
  server.registerTool(
    'setup_read_env',
    {
      title: 'Read Database Connection Env',      
      description: `Read and parse the config/db-connection.env file, returning all parameters as KEY=value lines. Sensitive fields (LICENSE, DB_PASSWORD, REDIS_PASSWORD, KAFKA_SASL_PASSWORD) are masked by default.

USE WHEN:
- The user asks to see the active/current configuration, parameters, 
  settings, or env values of a RESTForge project
- The user asks questions like "tampilkan parameter yang aktif", 
  "config apa yang sudah di-set", "show current settings", "cek konfigurasi", 
  "what's configured in this project"
- Verifying the current configuration before calling 'setup_write_env' or 
  'setup_update_env' to make changes
- Auditing the active config after a change
- Listing every parameter present in the file (including optional sections 
  like Live Sync, Redis, Kafka, Logging)
- Checking whether a RESTForge project has been set up at all (this tool 
  returns a clear "file not found" precondition if not)

DO NOT USE FOR:
- Writing values -> use 'setup_write_env' or 'setup_update_env'
- Validating connection -> use 'setup_validate_config'

This tool is READ-ONLY and safe to call repeatedly. Pass unmask=true to see real values of sensitive fields (use with care).

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "set up the initial config", "fill in the credentials", "update a single value", "validate the connection").
- Speak in plain language. Summarise the result; do not paste the full KEY=value list unless the user explicitly asks for it.
- Even when unmask=true, do not echo sensitive values (license keys, passwords) into chat unless the user explicitly asks. Prefer to confirm presence and length only.
- When a precondition is not met (e.g. config file is missing), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder'),
        configFile: z
          .string()
          .default('db-connection.env')
          .describe('Config file name in the config/ folder. Default: db-connection.env'),
        unmask: z
          .boolean()
          .default(false)
          .describe('When true, show real values of sensitive fields (LICENSE, *_PASSWORD). Default: false'),
      },
      annotations: {
        title: 'Read Env Config',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, configFile, unmask }) => {
      const projectCwd = resolve(cwd);
      const envPath = join(projectCwd, 'config', configFile);

      // Precondition check: the config file must exist before it can be read.
      // Treated as a non-error precondition per the authoring guide §3.4.
      try {
        await access(envPath);
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the configuration file does not exist yet.

Project path: ${projectCwd}
Expected file: ${envPath}

For the assistant:
- The user is trying to read a configuration that has not been created yet.
- Suggest generating the initial RESTForge configuration first, then retry reading it.
- When explaining to the user, say something like "the configuration file isn't there yet — should I set up the initial config first?". Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      // Real I/O failure: surface as error per §3.4.
      let content: string;
      try {
        content = await readFile(envPath, 'utf-8');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to read the configuration file.

Project path: ${projectCwd}
File: ${envPath}
Reason: ${msg}

For the assistant:
- Tell the user that the configuration file exists but could not be read.
- Summarise the likely cause (permissions, file lock, encoding) in plain language; do not paste the raw error unless the user explicitly asks.
- Offer to retry once the underlying issue is resolved. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      const entries = parseEnvFile(content);
      const kvEntries = entries.filter(
        (e): e is Extract<typeof e, { kind: 'kv' }> => e.kind === 'kv'
      );

      // Success: one-line summary + labeled facts + fenced parameter block per §3.5.
      const paramLines: string[] = [];
      for (const entry of kvEntries) {
        const displayValue =
          !unmask && isSensitiveKey(entry.key) ? maskValue(entry.value) : entry.value;
        paramLines.push(`${entry.key}=${displayValue}`);
      }

      const sensitiveNote = unmask
        ? 'Sensitive fields: UNMASKED (real values present in the parameter block below).'
        : 'Sensitive fields masked: LICENSE, DB_PASSWORD, REDIS_PASSWORD, KAFKA_SASL_PASSWORD.';

      const text = `Configuration file read successfully.

Project path: ${projectCwd}
File: ${envPath}
Total parameters: ${kvEntries.length}
${sensitiveNote}

--- Parameters ---
${paramLines.join('\n')}
--- end Parameters ---

For the assistant:
- Confirm to the user that the configuration was read successfully.
- Summarise in plain language: how many parameters are set, and which key sections appear to be configured (e.g. database, license, optional Redis/Kafka/Live Sync).
- Do not paste the full parameter block unless the user explicitly asks to see every value.
- ${unmask
          ? 'Sensitive values are unmasked in the parameter block. Do NOT echo license keys or passwords into chat. Only confirm their presence (or length) unless the user explicitly asks for the literal value.'
          : 'Sensitive values are masked. If the user wants to verify a real value, suggest re-running with the unmask option enabled.'}
- Do not mention internal tool names.`;

      return { content: [{ type: 'text', text }] };
    }
  );
}
