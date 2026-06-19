import { z } from 'zod';
import { readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerRuntimeDetectProject(server: McpServer): void {
  server.registerTool(
    'runtime_detect_project',
    {
      title: 'Detect RESTForge Project Names',
      description: `Detect RESTForge project names by scanning the conventional 'src/modules/' folder. Each .js file in that folder represents one RESTForge project; the filename without extension is the project name.

USE WHEN:
- The user asks "which projects are available?", "what RESTForge projects are in this folder?", "list project saya"
- Before generating a launcher script — to confirm the project name to pass as --project=<name>
- Before invoking 'runtime_generate_launcher' — to determine whether the user must specify a project name or one can be auto-detected
- The user requests to run the server but the project name is unknown or ambiguous

DO NOT USE FOR:
- Listing config files -> use 'runtime_detect_config'
- Listing payload spec files -> use generic Read or filesystem tools
- Listing database tables -> use 'codegen_list_tables'
- Validating runtime preflight -> use 'runtime_validate_preflight'

Preconditions:
- The 'src/modules/' folder must exist at <cwd>/src/modules/. If missing, the precondition response will say so.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user.
- When exactly one project is found, proceed without asking. When multiple are found, ask the user to pick one before generating the launcher.
- The project name comes from the filename in src/modules/ (without the .js extension); explain this in plain language if asked.
- When a precondition is not met (folder missing), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder root (must contain src/modules/)'),
      },
      annotations: {
        title: 'Detect Project Names',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd }) => {
      const projectCwd = resolve(cwd);
      const modulesDir = join(projectCwd, 'src', 'modules');

      let entries: string[];
      try {
        entries = await readdir(modulesDir);
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the modules folder does not exist.

Project path: ${projectCwd}
Expected folder: ${modulesDir}

For the assistant:
- The user is trying to detect RESTForge projects, but the conventional location 'src/modules/' is missing in this directory.
- Suggest verifying that the user is at the correct project root, or ask the user where the project files are located.
- Match the user's language. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const projects = entries
        .filter((name) => name.endsWith('.js'))
        .map((name) => name.replace(/\.js$/, ''));

      const envelope = {
        cwd: projectCwd,
        modules_dir: modulesDir,
        projects,
        count: projects.length,
      };
      const prettyJson = JSON.stringify(envelope, null, 2);

      if (projects.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No RESTForge project files were found in src/modules/.

Project path: ${projectCwd}
Modules folder: ${modulesDir}
Count: 0

--- Detection Result (JSON) ---
${prettyJson}
--- end Detection Result (JSON) ---

For the assistant:
- The src/modules/ folder exists but contains no .js files.
- A RESTForge project is conventionally a single .js file inside src/modules/ (e.g. mini-inventory.js -> project name 'mini-inventory').
- Suggest the user creates a project file there first, or verify they are at the right project root.
- Match the user's language. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const isSingle = projects.length === 1;
      const summary = isSingle
        ? `One RESTForge project detected: '${projects[0]}'.`
        : `${projects.length} RESTForge projects detected: ${projects.map((p) => `'${p}'`).join(', ')}.`;

      return {
        content: [
          {
            type: 'text',
            text: `${summary}

Project path: ${projectCwd}
Modules folder: ${modulesDir}
Count: ${projects.length}

--- Detection Result (JSON) ---
${prettyJson}
--- end Detection Result (JSON) ---

For the assistant:
- ${
              isSingle
                ? `Only one project was found, so the runtime can use '${projects[0]}' without further input.`
                : `Multiple projects were found. Ask the user which one to launch before proceeding.`
            }
- The project name comes from the filename in src/modules/ (without the .js extension). It is the value passed as --project=<name> when invoking the RESTForge runtime.
- Match the user's language. Do not mention internal tool names.`,
          },
        ],
        isError: false,
      };
    }
  );
}
