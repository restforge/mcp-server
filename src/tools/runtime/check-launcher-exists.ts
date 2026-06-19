import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const LAUNCHER_FILES = {
  windows: {
    start: 'server-start.bat',
    stop: 'server-stop.bat',
  },
  linux: {
    start: 'server-start.sh',
    stop: 'server-stop.sh',
  },
} as const;

const ECOSYSTEM_FILE = 'ecosystem.config.js';

function getLauncherFiles(os: 'windows' | 'linux', mode: 'host' | 'pm2'): string[] {
  const files: string[] = [LAUNCHER_FILES[os].start, LAUNCHER_FILES[os].stop];
  if (mode === 'pm2') {
    files.push(ECOSYSTEM_FILE);
  }
  return files;
}

export function registerRuntimeCheckLauncherExists(server: McpServer): void {
  server.registerTool(
    'runtime_check_launcher_exists',
    {
      title: 'Check Launcher File Existence',
      description: `Check whether the launcher files that would be produced by 'runtime_generate_launcher' already exist in the project root. Read-only — does not create or overwrite anything.

USE WHEN:
- Before invoking 'runtime_generate_launcher' — to detect potential overwrites and ask the user for confirmation
- The user wants to know which files would be created without committing
- The user is debugging an existing setup and wants to confirm what files exist

DO NOT USE FOR:
- Generating launcher files -> use 'runtime_generate_launcher'
- Reading the content of an existing launcher -> use generic Read tools
- Checking if the server is currently running -> use 'runtime_check_status'

The list of files depends on os + mode (file names are FIXED, not user-customisable):
- windows + host: server-start.bat, server-stop.bat
- windows + pm2:  server-start.bat, server-stop.bat, ecosystem.config.js
- linux + host:   server-start.sh, server-stop.sh
- linux + pm2:    server-start.sh, server-stop.sh, ecosystem.config.js

PRESENTATION GUIDANCE:
- Match the user's language.
- Never mention internal tool names.
- When at least one file already exists, ask the user whether to overwrite (then call generate with overwrite=true).
- Do not echo the JSON unless explicitly asked.`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder root'),
        os: z.enum(['windows', 'linux']).describe('Target OS for the launcher'),
        mode: z.enum(['host', 'pm2']).describe('Runtime mode'),
      },
      annotations: {
        title: 'Check Launcher Files',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, os, mode }) => {
      const projectCwd = resolve(cwd);
      const files = getLauncherFiles(os, mode);
      const checked = await Promise.all(
        files.map(async (f) => {
          const path = join(projectCwd, f);
          let exists = false;
          try {
            await access(path);
            exists = true;
          } catch {
            exists = false;
          }
          return { path, exists };
        })
      );
      const anyExists = checked.some((c) => c.exists);

      const envelope = {
        cwd: projectCwd,
        os,
        mode,
        files: checked,
        any_exists: anyExists,
      };
      const prettyJson = JSON.stringify(envelope, null, 2);

      const summary = anyExists
        ? 'One or more launcher files already exist in the project root.'
        : 'No conflicting launcher files. Safe to generate.';

      return {
        content: [
          {
            type: 'text',
            text: `${summary}

Project path: ${projectCwd}
OS: ${os}
Mode: ${mode}

--- Existence Check (JSON) ---
${prettyJson}
--- end Existence Check (JSON) ---

For the assistant:
- ${
              anyExists
                ? 'Some files would be overwritten. Ask the user whether to overwrite (then call generate with overwrite: true).'
                : 'No files would be overwritten. The user can proceed to generate.'
            }
- File names are fixed: server-start.{bat|sh}, server-stop.{bat|sh}, plus ecosystem.config.js for PM2 mode.
- Match the user's language.`,
          },
        ],
        isError: false,
      };
    }
  );
}
