import { z } from 'zod';
import { mkdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerSetupCreateFolder(server: McpServer): void {
  server.registerTool(
    'setup_create_folder',
    {
      title: 'Create Project Folder',
      description: `Create a new folder to serve as the root of a RESTForge project. The folder will host node_modules (@restforgejs/platform), config/, payload/, and generated src/.

USE WHEN:
- The user wants to set up a new RESTForge project working folder
- Starting a RESTForge project from scratch in a specific location
- The user says things like "buat folder project baru", "create a new project folder",
  "siapkan folder untuk project baru", "make a directory for my new RESTForge project",
  "bikinkan project baru di folder X", "scaffold a new restforge project"
- A safe mkdir with collision detection is needed

DO NOT USE FOR:
- Installing the @restforgejs/platform package -> use 'setup_install_package'
- Generating skeleton config -> use 'setup_init_config'
- Writing credentials -> use 'setup_write_env'

SCAFFOLDING NOTE:
The dominant way to create a new project is the one-shot scaffolder
'npx create-restforge-app <name>' (makes the folder, installs
@restforgejs/platform, bundles the designer). This tool is the GRANULAR
alternative — use it when the agent must build the project step by step.

In the granular flow this is the very first step in setting up a new RESTForge
project. The natural next step after this is 'setup_install_package' to install the
RESTForge package into the new folder. // per §5.2

This tool runs: fs.mkdir(<parentCwd>/<folderName>, { recursive: true })
Output: absolute path of the created folder. Pass this path as 'cwd' to subsequent setup_* tools.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "install the package", "set up the initial config").
- Speak in plain language. Confirm the folder was created and state the absolute path.
- When the folder already exists and force was not set, frame it as a choice or question, not as a hard error.`,
      inputSchema: {
        folderName: z
          .string()
          .min(1)
          .regex(/^[a-zA-Z0-9_-]+$/, 'Only alphanumeric, underscore, and dash are allowed')
          .default('backend-server')
          .describe('Project folder name. Default: backend-server'),
        parentCwd: z
          .string()
          .optional()
          .describe('Parent directory where the folder is created. Default: process.cwd()'),
        force: z
          .boolean()
          .default(false)
          .describe('Continue even if the folder already exists (mkdir recursive remains idempotent)'),
      },
      annotations: {
        title: 'Create Project Folder',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async ({ folderName, parentCwd, force }) => {
      const parent = parentCwd ? resolve(parentCwd) : process.cwd();
      const targetPath = join(parent, folderName);

      // Pre-check: detect whether the target folder already exists.
      let alreadyExists = false;
      try {
        await access(targetPath);
        alreadyExists = true;
      } catch {
        /* not present, OK to create */
      }

      // Already-exists collision (force=false): non-error precondition per §3.4.
      if (alreadyExists && !force) {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: a folder with this name already exists.

Parent directory: ${parent}
Folder name: ${folderName}
Existing path: ${targetPath}

For the assistant:
- The user asked to create a new project folder, but one with this name already exists.
- Offer the user a choice in plain words: pick a different folder name, reuse the existing folder (continue with force enabled, since recursive mkdir is idempotent), or cancel.
- Do not present this as a hard error. Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Real I/O failure: surface as error per §3.4.
      try {
        await mkdir(targetPath, { recursive: true });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to create the project folder.

Parent directory: ${parent}
Folder name: ${folderName}
Target path: ${targetPath}
Reason: ${msg}

For the assistant:
- Tell the user that the folder could not be created.
- Summarise the likely cause in plain language (permissions, parent missing, disk full); do not paste the raw error unless the user explicitly asks.
- Offer to retry once the underlying issue is resolved. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Success: one-line summary + labeled facts per §3.5.
      const stateNote = alreadyExists
        ? 'State: the folder already existed and was reused (force=true).'
        : 'State: a new folder was created.';

      return {
        content: [
          {
            type: 'text',
            text: `Project folder ready.

Parent directory: ${parent}
Folder name: ${folderName}
Absolute path: ${targetPath}
${stateNote}

For the assistant:
- Confirm to the user that the project folder is ready and state its absolute path.
- Suggest the next step in plain words: installing the RESTForge package into this folder so the project can be configured.
- Pass the absolute path above as the working-directory argument for subsequent setup actions. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
