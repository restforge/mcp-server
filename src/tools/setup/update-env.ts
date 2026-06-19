import { z } from 'zod';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  parseEnvFile,
  serializeEnvFile,
  mergeEnvEntries,
  isSensitiveKey,
  maskValue,
  type EnvFieldValue,
} from '../../lib/env-parser.js';

export function registerSetupUpdateEnv(server: McpServer): void {
  server.registerTool(
    'setup_update_env',
    {
      title: 'Update Database Connection Env',
      description: `Apply a partial update to config/db-connection.env. Accepts an arbitrary set of key/value pairs and merges them into the existing file, preserving comments, blank lines, and untouched parameters.

USE WHEN:
- Toggling individual feature flags (e.g. LIVE_SYNC_ENABLED, REDIS_ENABLED, KAFKA_ENABLED)
- Adjusting one or two values without restating the whole core connection
- Adding a new optional parameter that is not in the template

DO NOT USE FOR:
- Generating the initial config skeleton -> use 'setup_init_config'
- Bulk write of license + DB credentials -> use 'setup_write_env'
- Validating connection -> use 'setup_validate_config'

Behavior: read existing file, replace matching keys (preserving inline comments), append non-existing keys at the bottom, write back. Values may be string, number, or boolean (booleans serialize as 'true'/'false'). Values containing spaces, '=' or '#' are auto-quoted.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "set up the initial config", "fill in the credentials", "validate the connection").
- Speak in plain language. Summarise the result by counting and naming the changed keys; do not paste the full diff block unless the user explicitly asks.
- Do not echo sensitive values (license keys, passwords) into chat even when they appear masked in the response. Confirm presence and length only.
- When a precondition is not met (e.g. config file is missing), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder'),
        configFile: z
          .string()
          .default('db-connection.env')
          .describe('Config file name in the config/ folder. Default: db-connection.env'),
        fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .refine((obj) => Object.keys(obj).length > 0, {
            message: 'fields must contain at least one key',
          })
          .describe('Key-value map of parameters to update or add. Example: { "DB_PORT": 5433, "KAFKA_ENABLED": true }'),
      },
      annotations: {
        title: 'Update Env Config',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async ({ cwd, configFile, fields }) => {
      const projectCwd = resolve(cwd);
      const envPath = join(projectCwd, 'config', configFile);

      // Precondition check: the config file must exist before it can be updated.
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
- The user is trying to update a configuration that has not been created yet.
- Suggest generating the initial RESTForge configuration first, then retry the update.
- When explaining to the user, say something like "the configuration file isn't there yet — should I set up the initial config first?". Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      // Real I/O failure on read: surface as error per §3.4.
      let existingContent: string;
      try {
        existingContent = await readFile(envPath, 'utf-8');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to read the configuration file before applying the update.

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

      const existingEntries = parseEnvFile(existingContent);
      const merged = mergeEnvEntries(existingEntries, fields as Record<string, EnvFieldValue>);
      const newContent = serializeEnvFile(merged.entries);

      // Real I/O failure on write: surface as error per §3.4.
      try {
        await writeFile(envPath, newContent, 'utf-8');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to write the updated configuration to disk.

Project path: ${projectCwd}
File: ${envPath}
Reason: ${msg}

For the assistant:
- Tell the user that the update could not be persisted.
- Summarise the likely cause (permissions, disk full, file lock) in plain language; do not paste the raw error unless the user explicitly asks.
- The original file is unchanged. Offer to retry once the underlying issue is resolved. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      // Success: labeled facts + fenced change summary per §3.5.
      const formatChange = (key: string, before: string, after: string): string => {
        if (isSensitiveKey(key)) {
          return `  - ${key}: ${maskValue(before)} -> ${maskValue(after)}`;
        }
        return `  - ${key}: ${before} -> ${after}`;
      };

      const formatAdd = (key: string, value: string): string => {
        const v = isSensitiveKey(key) ? maskValue(value) : value;
        return `  - ${key}=${v}`;
      };

      const changeBlockLines: string[] = [
        `Updated fields (${merged.updated.length}):`,
        ...(merged.updated.length === 0
          ? ['  (none)']
          : merged.updated.map((u) => formatChange(u.key, u.before, u.after))),
        '',
        `Added fields (${merged.added.length}):`,
        ...(merged.added.length === 0
          ? ['  (none)']
          : merged.added.map((a) => formatAdd(a.key, a.value))),
        '',
        `Unchanged fields (${merged.unchanged.length}): preserved`,
      ];

      const sensitiveTouched =
        merged.updated.some((u) => isSensitiveKey(u.key)) ||
        merged.added.some((a) => isSensitiveKey(a.key));

      const text = `Configuration updated successfully.

Project path: ${projectCwd}
File: ${envPath}
Updated keys: ${merged.updated.length}
Added keys: ${merged.added.length}
Unchanged keys: ${merged.unchanged.length}

--- Changes ---
${changeBlockLines.join('\n')}
--- end Changes ---

For the assistant:
- Confirm to the user that the configuration was updated.
- Summarise in plain language: how many keys were changed and added, and name the most relevant ones (without listing every single one unless asked).
- Do not paste the full change block unless the user explicitly asks.
- ${sensitiveTouched
          ? 'A sensitive value (license or password) was changed or added. Do NOT echo the new value into chat. Confirm only that it was set.'
          : 'No sensitive values were changed in this update.'}
- Suggest validating the configuration as the next step. Do not mention internal tool names.`;

      return { content: [{ type: 'text', text }] };
    }
  );
}
