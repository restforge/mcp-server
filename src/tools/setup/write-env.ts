import { z } from 'zod';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  parseEnvFile,
  serializeEnvFile,
  mergeEnvEntries,
  type EnvFieldValue,
} from '../../lib/env-parser.js';

export function registerSetupWriteEnv(server: McpServer): void {
  server.registerTool(
    'setup_write_env',
    {
      title: 'Write Database Connection Env',
      description: `Write license, server settings, and database credentials into config/db-connection.env using a partial-merge strategy that preserves all other parameters and comments in the file.

USE WHEN:
- The user provides a complete set of license + database credentials in one go
- The user is doing initial credential setup (first time filling in the empty template)
- You need to fill in or update ALL core connection fields together (license, 
  server, database) — even if some values are already set, this tool will 
  overwrite them consistently
- The user says things like "isi credentials", "setup koneksi database", 
  "fill in the connection info", "atur license dan database"

DO NOT USE FOR:
- Generating the initial config skeleton -> use 'setup_init_config'
- Changing only one or two fields (e.g. just the password, or toggle a flag) -> use 'setup_update_env'
- Validating license/connection -> use 'setup_validate_config'

Behavior: read existing file, update LICENSE/SERVER_*/DB_* entries in place, append any missing keys at the bottom, and write back. Comments, blank lines, and unrelated parameters are preserved verbatim. Output file: <cwd>/config/db-connection.env.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "set up the initial config", "update a single value", "validate the connection").
- Speak in plain language. Summarise what was written; do not paste the full field list unless the user explicitly asks.
- Do not echo sensitive values (license keys, passwords) into chat even when they appear masked in the response. Confirm only that they were set.
- When a precondition is not met (e.g. config file is missing), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder'),
        license: z
          .string()
          .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Format must be XXXX-XXXX-XXXX-XXXX'),
        serverAddress: z.string().default('127.0.0.1'),
        serverPort: z.number().int().min(1).max(65535).default(3000),
        dbType: z.enum(['postgresql', 'mysql', 'oracle', 'sqlite']),
        dbHost: z.string().min(1),
        dbPort: z.number().int().min(1).max(65535),
        dbUser: z.string().min(1),
        dbPassword: z.string(),
        dbName: z.string().min(1),
      },
      annotations: {
        title: 'Write Env Config',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const projectCwd = resolve(args.cwd);
      const configDir = join(projectCwd, 'config');
      const envPath = join(configDir, 'db-connection.env');

      // Precondition check: the config file must exist before it can be written.
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
- The user is trying to write credentials into a configuration that has not been created yet.
- Suggest generating the initial RESTForge configuration first, then retry filling in the credentials.
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
              text: `Failed to read the configuration file before applying the credentials.

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

      const fields: Record<string, EnvFieldValue> = {
        LICENSE: args.license,
        SERVER_ADDRESS: args.serverAddress,
        SERVER_PORT: args.serverPort,
        DB_TYPE: args.dbType,
        DB_HOST: args.dbHost,
        DB_PORT: args.dbPort,
        DB_USER: args.dbUser,
        DB_PASSWORD: args.dbPassword,
        DB_NAME: args.dbName,
      };

      const existingEntries = parseEnvFile(existingContent);
      const merged = mergeEnvEntries(existingEntries, fields);
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
              text: `Failed to write the credentials to the configuration file.

Project path: ${projectCwd}
File: ${envPath}
Reason: ${msg}

For the assistant:
- Tell the user that the credentials could not be saved.
- Summarise the likely cause (permissions, disk full, file lock) in plain language; do not paste the raw error unless the user explicitly asks.
- The original file is unchanged. Offer to retry once the underlying issue is resolved. Do not mention internal tool names.`,
            },
          ],
          isError: true,
        };
      }

      // Success: labeled facts + masked summary per §3.5.
      const updatedKeys = merged.updated.map((u) => u.key);
      const addedKeys = merged.added.map((a) => a.key);
      const unchangedCount = merged.unchanged.length;

      const text = `Credentials and connection settings written successfully.

Project path: ${projectCwd}
File: ${envPath}
License: ${args.license.slice(0, 4)}-****-****-****
Server: ${args.serverAddress}:${args.serverPort}
Database: ${args.dbType}://${args.dbUser}:***@${args.dbHost}:${args.dbPort}/${args.dbName}

Updated keys (${updatedKeys.length}): ${updatedKeys.join(', ') || '(none)'}
Added keys (${addedKeys.length}): ${addedKeys.join(', ') || '(none)'}
Unchanged keys (${unchangedCount}): preserved (Live Sync, Redis, Kafka, Logging, etc.)

For the assistant:
- Confirm to the user that the license and database credentials were saved.
- Summarise in plain language: which database is configured (type, host, name) and that the license is set; do not echo the literal license key or password.
- Do not paste the masked summary block verbatim unless the user explicitly asks for the details.
- Suggest validating the configuration as the next step (license check + database connectivity). Do not mention internal tool names.`;

      return { content: [{ type: 'text', text }] };
    }
  );
}
