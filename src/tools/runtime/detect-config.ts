import { z } from 'zod';
import { readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerRuntimeDetectConfig(server: McpServer): void {
  server.registerTool(
    'runtime_detect_config',
    {
      title: 'Detect RESTForge Config Files',
      description: `Detect RESTForge configuration files by scanning the 'config/' folder for .env files. Each .env file is a candidate config to pass via --config=<filename> when invoking the RESTForge runtime.

USE WHEN:
- The user asks "which config files are available?", "config apa saja yang ada", "list .env"
- Before generating a launcher script — to confirm which config file to pass
- Before invoking 'runtime_generate_launcher' — to know if a config exists at all
- The user mentions running the server but the config file is unknown or ambiguous

DO NOT USE FOR:
- Listing project names -> use 'runtime_detect_project'
- Reading content of a specific .env file -> use 'setup_read_env'
- Validating connection credentials in a config -> use 'setup_validate_config' or 'runtime_validate_preflight'

Preconditions:
- The 'config/' folder must exist at <cwd>/config/. If missing, the precondition response will say so.

PRESENTATION GUIDANCE:
- Match the user's language.
- Never mention internal tool names.
- When exactly one config file is found, proceed without asking. When multiple are found, ask the user which environment they want.
- The filename is what gets passed as --config=<filename>; the runtime will resolve it relative to the config/ folder automatically.
- When a precondition is not met (folder missing or empty), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder root (must contain config/)'),
      },
      annotations: {
        title: 'Detect Config Files',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd }) => {
      const projectCwd = resolve(cwd);
      const configDir = join(projectCwd, 'config');

      let entries: string[];
      try {
        entries = await readdir(configDir);
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the config folder does not exist.

Project path: ${projectCwd}
Expected folder: ${configDir}

For the assistant:
- No config/ folder was found in this project.
- Before launching the runtime, the user needs at least one .env config file in 'config/'.
- Suggest setting up the initial config first (e.g. via the setup tools).
- Match the user's language. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const configs = entries.filter((name) => name.endsWith('.env'));
      const envelope = {
        cwd: projectCwd,
        config_dir: configDir,
        configs,
        count: configs.length,
      };
      const prettyJson = JSON.stringify(envelope, null, 2);

      if (configs.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No .env config files were found in config/.

Project path: ${projectCwd}
Config folder: ${configDir}
Count: 0

--- Detection Result (JSON) ---
${prettyJson}
--- end Detection Result (JSON) ---

For the assistant:
- The config/ folder exists but contains no .env files.
- The user needs to create one before launching the runtime (e.g. db-connection.env).
- Suggest setting up the initial config.
- Match the user's language. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const isSingle = configs.length === 1;
      const summary = isSingle
        ? `One config file detected: '${configs[0]}'.`
        : `${configs.length} config files detected: ${configs.map((c) => `'${c}'`).join(', ')}.`;

      return {
        content: [
          {
            type: 'text',
            text: `${summary}

Project path: ${projectCwd}
Config folder: ${configDir}
Count: ${configs.length}

--- Detection Result (JSON) ---
${prettyJson}
--- end Detection Result (JSON) ---

For the assistant:
- ${
              isSingle
                ? `Only one config file is present, so it can be used without asking.`
                : `Multiple config files are present. Ask the user which environment to use (e.g. db-connection.env vs production.env).`
            }
- The config filename is passed to the runtime as --config=<filename>.
- Match the user's language. Do not mention internal tool names.`,
          },
        ],
        isError: false,
      };
    }
  );
}
