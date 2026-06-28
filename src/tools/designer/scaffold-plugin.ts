import { z } from 'zod';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDesignerScaffoldPlugin(server: McpServer): void {
  server.registerTool(
    'designer_scaffold_plugin',
    {
      title: 'Scaffold Designer Plugin',
      description: `Scaffold a new custom RESTForge Designer frontend plugin from a template, by running npx restforge-designer plugins scaffold. This WRITES a new plugin folder to disk that the user can then customise.

USE WHEN:
- The user asks to create a new custom designer/frontend plugin from scratch
- The user asks things like "buat plugin custom baru", "scaffold folder plugin designer", "mulai plugin frontend dari template", "create a new designer plugin", "scaffold a frontend plugin", "bikin plugin frontend baru"
- The user wants a starter plugin folder they can edit to build their own frontend generator template
- The user names a new plugin id and wants the folder structure generated for it

DO NOT USE FOR:
- Generating a frontend application from a UDF payload -> use 'designer_generate'
- Initialising a project from an existing plugin -> use 'designer_init_project'
- Listing the available plugins -> use 'designer_list_plugins'
- Inspecting one existing plugin's metadata -> use 'designer_inspect_plugin'

This tool wraps the RESTForge Designer CLI command: npx restforge-designer plugins scaffold --id=<id> --output=<output> [--plugins-dir=<pluginsDir>], run in the given cwd.
The CLI creates a new plugin folder named after the given id under the output directory. It does NOT require a license (scaffolding is license-free).

Preconditions:
- RESTForge Designer is invoked via 'npx restforge-designer' (the binary is bundled with the @restforgejs/platform package). This tool pre-checks that by running
  'npx restforge-designer --version'; if it cannot run, the response will surface that as a non-error precondition.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "scaffold a new plugin", "list the available plugins", "generate the frontend code").
- Speak in plain language. Confirm what was created and where; do not paste raw CLI output unless the user explicitly asks.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the working directory where the binary is run'),
        id: z
          .string()
          .min(1)
          .describe('The id of the new plugin to scaffold (e.g. my-custom-plugin)'),
        output: z
          .string()
          .min(1)
          .describe('Path to the output folder where the new plugin will be created (relative to cwd or absolute)'),
        pluginsDir: z
          .string()
          .min(1)
          .optional()
          .describe('Override path to the plugins folder. When omitted, the binary auto-detects the plugins directory.'),
      },
      annotations: {
        title: 'Scaffold Designer Plugin',
        destructiveHint: false, // creates a new plugin folder; does not delete or overwrite existing data
        idempotentHint: false,  // each call attempts to create a new plugin folder
      },
    },
    async ({ cwd, id, output, pluginsDir }) => {
      const projectCwd = resolve(cwd);

      // Precondition check: the restforge-designer binary must be reachable on PATH.
      // Treated as a non-error precondition per the authoring guide §3.4.
      const probe = await execProcess('npx', ['restforge-designer', '--version'], {
        cwd: projectCwd,
        timeout: 10_000,
      });
      if (!probe.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the RESTForge Designer command-line tool could not be run via npx (the @restforgejs/platform package may not be installed in this folder).

Working directory: ${projectCwd}
Plugin id: ${id}
Output: ${output}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Probe command: ${probe.command}
Exit code: ${probe.exitCode}

For the assistant:
- Make sure this project was created with 'npx create-restforge-app' (or the @restforgejs/platform package is installed in the project folder) before a plugin can be scaffolded, then try again.
- When explaining to the user, say something like "the RESTForge Designer tool couldn't run — make sure this project was created with create-restforge-app (or the RESTForge platform package is installed here), then try again". Do not mention internal tool names.
- Once it can run, retry scaffolding the plugin.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied. Required flags are always sent. per §3.5 / D6
      const args = ['plugins', 'scaffold', `--id=${id}`, `--output=${output}`];
      if (pluginsDir) args.push(`--plugins-dir=${pluginsDir}`);

      const result = await execProcess('npx', ['restforge-designer', ...args], {
        cwd: projectCwd,
        timeout: 30_000,
      });

      // D9: write tool. A non-zero exit (incl. -1 crash/timeout) means the write did
      // not complete cleanly — the plugin folder may be missing or partial, so the
      // model needs to recover -> isError: true.
      if (result.exitCode !== 0) {
        const stderrBlock = result.stderr
          ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
          : '';
        return {
          content: [
            {
              type: 'text',
              text: `Scaffolding the Designer plugin did not complete.

Working directory: ${projectCwd}
Plugin id: ${id}
Output: ${output}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- The scaffold did not finish successfully, so the plugin folder may not exist or may be partial. Read the CLI output above and explain the most likely cause to the user in plain language. Common causes:
  * The output directory already exists or is not writable — suggest a different output path or clearing the existing folder.
  * The plugin id is invalid (bad characters) — suggest a simpler id.
  * Exit code -1 — the command crashed or timed out; offer to retry.
- Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names. Match the user's language.`,
            },
          ],
          isError: true, // per §3.4 / D9 — write did not complete
        };
      }

      // D9: success — exit 0. Labeled facts + fenced raw output per §3.5.
      const stderrBlock = result.stderr
        ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
        : '';
      return {
        content: [
          {
            type: 'text',
            text: `Designer plugin scaffolded successfully.

Working directory: ${projectCwd}
Plugin id: ${id}
Output: ${output}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- Confirm to the user that the new plugin folder was created. Mention the plugin id and the output location in plain language.
- The scaffold is a starting point: the user will edit the generated plugin files (templates, schema) to build their own frontend generator.
- Suggest a sensible next step, e.g. inspecting or listing the plugins to confirm the new one is picked up, or authoring a UDF payload that targets it.
- Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names. Match the user's language.`,
          },
        ],
      };
    }
  );
}
